/* eslint-disable no-await-in-loop */
import yaml from 'js-yaml';
import { readSubtasksFromFiles, STATUS_TEXTS, SubtaskType } from '@hydrooj/common';
import {
    BadRequestError, Context, Handler, ObjectId, OplogModel, PERM, ProblemIsReferencedError,
    ProblemModel, ProblemNotFoundError, RecordModel, route, STATUS, Types, ValidationError,
    post,
} from 'hydrooj';
import type { ProblemConfigFile, SubtaskConfig, TestCaseConfig } from '@hydrooj/common';

const SOURCE_PREFIX = 'std-time-calibrator';
const CALIBRATION_TIME = '5000ms';
const CALIBRATION_MEMORY = '1024m';
const TIME_STEP = 500;
const MIN_TIME = 1000;
const MEMORY_STEP = 128;
const MEMORY_EXTRA = 128;
const CLEANUP_DELAY = 30 * 60 * 1000;
const SYNC_RETRY_DELAY = 5000;
const MAX_SYNC_RETRIES = 5;

function sleep(ms: number) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

interface CalibrationSource {
    domainId: string;
    pid: number;
    tempPid: number;
    applied: boolean;
    state: string;
    retry: number;
}

function isConfigName(name: string) {
    return ['config.yaml', 'config.yml'].includes(name.toLowerCase());
}

function cloneConfig(config: ProblemConfigFile): ProblemConfigFile {
    return JSON.parse(JSON.stringify(config || {}));
}

function loadConfig(raw: string | ProblemConfigFile): ProblemConfigFile {
    if (!raw) return {};
    if (typeof raw !== 'string') return cloneConfig(raw);
    const config = yaml.load(raw) as ProblemConfigFile;
    if (!config) return {};
    if (typeof config !== 'object' || Array.isArray(config)) throw new ValidationError('config');
    return cloneConfig(config);
}

function ensureSubtasks(config: ProblemConfigFile, files: { name: string }[]) {
    const next = cloneConfig(config);
    if (!next.subtasks?.length && next.cases?.length) {
        const score = (next.score || 0) * next.cases.length;
        next.subtasks = [{
            type: SubtaskType.sum,
            score: score && score < 100 ? score : 100,
            cases: next.cases,
            id: 1,
        }];
        delete next.cases;
        delete next.score;
    }
    if (!next.subtasks?.length) {
        next.subtasks = readSubtasksFromFiles(
            files.map((i) => i.name).filter((name) => !isConfigName(name)),
            next,
        ) as any as SubtaskConfig[];
    }
    if (!next.subtasks?.length) throw new ValidationError('testdata', null, 'Problem data not found.');
    next.subtasks.forEach((subtask, index) => {
        subtask.id ||= index + 1;
        subtask.cases ||= [];
        if (!subtask.cases.length) throw new ValidationError('subtasks');
    });
    return next;
}

function withCalibrationLimits(config: ProblemConfigFile, lang: string) {
    const next = cloneConfig(config);
    next.time = CALIBRATION_TIME;
    next.memory = CALIBRATION_MEMORY;
    next.detail = 'full';
    next.time_limit_rate = { ...(next.time_limit_rate || {}), [lang]: 1 };
    next.memory_limit_rate = { ...(next.memory_limit_rate || {}), [lang]: 1 };
    for (const subtask of next.subtasks || []) {
        subtask.time = CALIBRATION_TIME;
        subtask.memory = CALIBRATION_MEMORY;
        subtask.type = SubtaskType.sum;
        for (const testcase of subtask.cases || []) {
            testcase.time = CALIBRATION_TIME;
            testcase.memory = CALIBRATION_MEMORY;
        }
    }
    return next;
}

function roundTime(time: number) {
    return Math.max(MIN_TIME, Math.ceil(time / TIME_STEP) * TIME_STEP);
}

function roundMemory(memoryKb: number) {
    const usedMb = Math.ceil(Math.max(memoryKb || 0, 0) / 1024);
    return Math.ceil(usedMb / MEMORY_STEP) * MEMORY_STEP + MEMORY_EXTRA;
}

function applyMeasuredLimits(config: ProblemConfigFile, cases: any[]) {
    const next = cloneConfig(config);
    const result: { id: number, time: number, memory: number, maxCaseTime: number, maxCaseMemory: number }[] = [];
    let maxSubtaskTime = 0;
    let maxSubtaskMemory = 0;
    for (const [index, subtask] of (next.subtasks || []).entries()) {
        const subtaskId = subtask.id || index + 1;
        const matched = cases.filter((testcase) => testcase.subtaskId === subtaskId);
        if (!matched.length) throw new ValidationError('testCases', null, `No test case result for subtask ${subtaskId}.`);
        const maxCaseTime = Math.max(...matched.map((testcase) => testcase.time || 0));
        const maxCaseMemory = Math.max(...matched.map((testcase) => testcase.memory || 0));
        const time = roundTime(maxCaseTime * 2);
        const memory = roundMemory(maxCaseMemory);
        maxSubtaskTime = Math.max(maxSubtaskTime, time);
        maxSubtaskMemory = Math.max(maxSubtaskMemory, memory);
        subtask.time = `${time}ms`;
        subtask.memory = `${memory}m`;
        for (const testcase of subtask.cases || []) {
            delete (testcase as TestCaseConfig).time;
            delete (testcase as TestCaseConfig).memory;
        }
        result.push({ id: subtaskId, time, memory, maxCaseTime, maxCaseMemory });
    }
    if (maxSubtaskTime) next.time = `${maxSubtaskTime}ms`;
    if (maxSubtaskMemory) next.memory = `${maxSubtaskMemory}m`;
    return { config: next, result };
}

function buildSource(domainId: string, pid: number, tempPid = 0, state = 'pending', retry = 0) {
    return `${SOURCE_PREFIX}:${domainId}:${pid}:${tempPid}:${state}:${retry}`;
}

function parseSource(source = '') {
    const [prefix, domainId, pid, tempPid = '0', state = 'pending', retry = '0'] = source.split(':');
    if (prefix !== SOURCE_PREFIX) return null;
    if (!Number.isSafeInteger(+pid) || !Number.isSafeInteger(+tempPid)) return null;
    const retryCount = Number.isSafeInteger(+retry) ? +retry : 0;
    return {
        domainId,
        pid: +pid,
        tempPid: +tempPid,
        applied: state === 'applied',
        state,
        retry: retryCount,
    } as CalibrationSource;
}

function recordMessages(rdoc: any) {
    return [
        ...(rdoc.judgeTexts || []),
        ...(rdoc.compilerTexts || []),
        ...(rdoc.testCases || []).map((testcase) => testcase.message || ''),
    ].filter(Boolean).join('\n');
}

function isSyncingTestdata(rdoc: any) {
    return /syncing\s+testdata|testdata.*please\s+wait/i.test(recordMessages(rdoc));
}

async function finalizeCalibration(rdoc: any, source: CalibrationSource) {
    const pdoc = await ProblemModel.get(source.domainId, source.pid, ProblemModel.PROJECTION_PUBLIC, true);
    if (!pdoc) throw new ProblemNotFoundError(source.domainId, source.pid);
    const config = ensureSubtasks(loadConfig(pdoc.config), pdoc.data || []);
    const { config: nextConfig, result } = applyMeasuredLimits(config, rdoc.testCases || []);
    if (!source.applied) {
        await ProblemModel.addTestdata(
            source.domainId,
            source.pid,
            'config.yaml',
            Buffer.from(yaml.dump(nextConfig)),
            rdoc.uid,
        );
        await RecordModel.update(source.domainId, rdoc._id, {
            source: buildSource(source.domainId, source.pid, source.tempPid, 'applied', source.retry),
        });
    }
    return result;
}

async function cleanupTempProblem(source: CalibrationSource) {
    if (!source.tempPid) return;
    await ProblemModel.del(source.domainId, source.tempPid).catch(() => null);
}

async function markCalibrationState(rdoc: any, source: CalibrationSource, state: string) {
    await RecordModel.update(source.domainId, rdoc._id, {
        source: buildSource(source.domainId, source.pid, source.tempPid, state, source.retry),
    });
}

async function retryAfterTestdataSync(rdoc: any, source: CalibrationSource, logger?: any) {
    if (source.applied || source.retry >= MAX_SYNC_RETRIES) return false;
    const nextRetry = source.retry + 1;
    const nextSource = buildSource(source.domainId, source.pid, source.tempPid, 'retry', nextRetry);
    const claimed = await RecordModel.coll.updateOne({
        _id: rdoc._id,
        domainId: source.domainId,
        source: rdoc.source,
    }, {
        $set: { source: nextSource },
    });
    if (!claimed.modifiedCount) return true;
    await RecordModel.reset(source.domainId, rdoc._id, false);
    logger?.info?.(`retry ${nextRetry}/${MAX_SYNC_RETRIES} after testdata sync delay for record ${rdoc._id}`);
    await sleep(SYNC_RETRY_DELAY);
    const pdoc = await ProblemModel.get(source.domainId, source.pid, ProblemModel.PROJECTION_PUBLIC, true);
    if (!pdoc) throw new ProblemNotFoundError(source.domainId, source.pid);
    const config = ensureSubtasks(loadConfig(pdoc.config), pdoc.data || []);
    await RecordModel.judge(source.domainId, rdoc._id, 5000, withCalibrationLimits(config, rdoc.lang), { type: 'judge' });
    return true;
}

async function processCalibrationRecord(rdoc: any, logger: any) {
    const source = parseSource(rdoc.source);
    if (!source || !rdoc.judgeAt) return;
    if (!source.applied && isSyncingTestdata(rdoc)) {
        if (await retryAfterTestdataSync(rdoc, source, logger)) return;
    }
    if (!source.applied && rdoc.status === STATUS.STATUS_ACCEPTED) {
        try {
            await finalizeCalibration(rdoc, source);
        } catch (e) {
            logger.error(e);
        }
        return;
    }
    if (!source.applied && rdoc.status !== STATUS.STATUS_ACCEPTED && !source.tempPid) {
        await markCalibrationState(rdoc, source, 'failed');
        return;
    }
    if (Date.now() - new Date(rdoc.judgeAt).getTime() > CLEANUP_DELAY) {
        await cleanupTempProblem(source);
        await markCalibrationState(rdoc, source, 'expired');
    }
}

class StdTimeCalibratorHandler extends Handler {
    pdoc: any;

    @route('pid', Types.ProblemId)
    async _prepare(domainId: string, pid: string | number) {
        this.pdoc = await ProblemModel.get(domainId, pid, ProblemModel.PROJECTION_PUBLIC, true);
        if (!this.pdoc) throw new ProblemNotFoundError(domainId, pid);
        if (this.pdoc.reference) throw new ProblemIsReferencedError('edit config');
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }

    @post('lang', Types.String)
    @post('code', Types.Content)
    async postSubmit(domainId: string, lang: string, code: string) {
        if (!code.trim()) throw new ValidationError('code');
        const config = ensureSubtasks(loadConfig(this.pdoc.config), this.pdoc.data || []);
        if (['remote_judge', 'objective', 'submit_answer'].includes(config.type as string)) throw new BadRequestError();
        const rid = await RecordModel.add(domainId, this.pdoc.docId, this.user._id, lang, code, false, {
            contest: RecordModel.RECORD_GENERATE,
            type: 'judge',
        });
        await RecordModel.update(domainId, rid, {
            source: buildSource(domainId, this.pdoc.docId),
        });
        await RecordModel.judge(domainId, rid, 5000, withCalibrationLimits(config, lang), { type: 'judge' });
        this.response.body = { rid };
    }

    @post('rid', Types.ObjectId)
    async postStatus(domainId: string, rid: ObjectId) {
        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc) throw new ValidationError('rid');
        const source = parseSource(rdoc.source);
        if (!source || source.domainId !== domainId || source.pid !== this.pdoc.docId || rdoc.uid !== this.user._id) {
            throw new ValidationError('rid');
        }
        if (!rdoc.judgeAt) {
            this.response.body = {
                done: false,
                progress: rdoc.progress || 0,
                status: rdoc.status,
                statusText: STATUS_TEXTS[rdoc.status],
            };
            return;
        }
        if (!source.applied && isSyncingTestdata(rdoc)) {
            if (await retryAfterTestdataSync(rdoc, source, this.ctx.logger('std-time-calibrator'))) {
                this.response.body = {
                    done: false,
                    progress: 0,
                    status: STATUS.STATUS_WAITING,
                    statusText: `Syncing testdata, retrying ${source.retry + 1}/${MAX_SYNC_RETRIES}...`,
                };
                return;
            }
        }
        if (rdoc.status !== STATUS.STATUS_ACCEPTED) {
            await cleanupTempProblem(source);
            await markCalibrationState(rdoc, source, 'failed');
            this.response.body = {
                done: true,
                updated: false,
                status: rdoc.status,
                statusText: STATUS_TEXTS[rdoc.status],
                compilerTexts: rdoc.compilerTexts,
                judgeTexts: rdoc.judgeTexts,
            };
            return;
        }
        const config = ensureSubtasks(loadConfig(this.pdoc.config), this.pdoc.data || []);
        const result = source.applied
            ? applyMeasuredLimits(config, rdoc.testCases || []).result
            : await finalizeCalibration(rdoc, source);
        await Promise.all([
            OplogModel.log(this, 'problem.std_time_calibrate', {
                pid: this.pdoc.docId,
                rid,
                result,
            }),
            cleanupTempProblem(source),
        ]);
        this.response.body = {
            done: true,
            updated: true,
            status: rdoc.status,
            statusText: STATUS_TEXTS[rdoc.status],
            result,
        };
    }
}

export async function apply(ctx: Context) {
    const logger = ctx.logger('std-time-calibrator');
    ctx.Route('problem_std_time_calibrator', '/p/:pid/std-time-calibrator', StdTimeCalibratorHandler);
    ctx.on('record/judge', async (rdoc) => {
        if (rdoc.status !== STATUS.STATUS_ACCEPTED) return;
        const source = parseSource(rdoc.source);
        if (!source || source.applied) return;
        try {
            await finalizeCalibration(rdoc, source);
        } catch (e) {
            logger.error(e);
        }
    });
    ctx.interval(async () => {
        const rdocs = await RecordModel.coll.find({
            source: { $regex: `^${SOURCE_PREFIX}:[^:]+:\\d+:\\d+:(pending|retry):\\d+$` },
            judgeAt: { $ne: null },
        }).limit(20).toArray();
        for (const rdoc of rdocs) await processCalibrationRecord(rdoc, logger);
    }, 10 * 1000);
    ctx.i18n.load('zh', {
        'Calibrate By Standard Solution': '用标程校准时限和内存',
        'Calibration submitted.': '标程评测已提交。',
        'Language': '语言',
        'Please enter standard solution.': '请输入标程。',
        'Run Standard Solution': '运行标程',
        'Standard Solution': '标程',
        'Time limits have been updated.': '评测时限和内存限制已更新。',
        'Waiting for judge result...': '正在等待评测结果...',
    });
    ctx.i18n.load('en', {
        'Calibrate By Standard Solution': 'Calibrate Time and Memory By Standard Solution',
        'Calibration submitted.': 'Calibration submitted.',
        'Language': 'Language',
        'Please enter standard solution.': 'Please enter standard solution.',
        'Run Standard Solution': 'Run Standard Solution',
        'Standard Solution': 'Standard Solution',
        'Time limits have been updated.': 'Time and memory limits have been updated.',
        'Waiting for judge result...': 'Waiting for judge result...',
    });
}
