import { Context, PRIV, Handler, param, Types, RecordModel, ObjectId, ProblemModel, DomainModel, RecordNotFoundError, StorageModel, ProblemNotFoundError, STATUS, yaml, ProblemConfigFile, DocumentModel, ForbiddenError, NotFoundError } from 'hydrooj';
import { Setting } from 'hydrooj/src/model/setting';

const TARGET_STATUS = [
    STATUS.STATUS_RUNTIME_ERROR,        // RE  
    STATUS.STATUS_TIME_LIMIT_EXCEEDED,  // TLE  
    STATUS.STATUS_MEMORY_LIMIT_EXCEEDED, // MLE  
    STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED, // OLE  
    STATUS.STATUS_WRONG_ANSWER          // WA  
];

class DownloadFirstDataHandler extends Handler {
    @param('rid', Types.ObjectId)
    @param('category', Types.Range(['in', 'out']))
    async get(domainId: string, rid: ObjectId, category: string) {
        if (!this.domain.enableDownloadFirst) {
            throw new ForbiddenError('This feature is disabled in this domain');
        }

        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc) throw new RecordNotFoundError(rid);
        if (this.user._id !== rdoc.uid) throw new ForbiddenError(rid);

        const pdoc = await DocumentModel.get(domainId, DocumentModel.TYPE_PROBLEM, rdoc.pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, rdoc.pid);

        let spdoc = pdoc;
        if (pdoc.reference) {
            const reference = pdoc.reference;
            const ddoc_reference = await DomainModel.get(reference.domainId);
            if (!ddoc_reference) throw new NotFoundError(reference.domainId);
            // console.log(reference.domainId, reference.pid);
            const pdoc_reference = await DocumentModel.get(reference.domainId, DocumentModel.TYPE_PROBLEM, reference.pid);
            if (!pdoc_reference) throw new ProblemNotFoundError(reference.domainId, reference.pid);
            // console.log(pdoc_reference);
            spdoc = pdoc_reference;
        }

        const testCases = rdoc.testCases.sort((a, b) => {
            // if (a.id !== b.id) return a.id - b.id;
            // return a.subtaskId - b.subtaskId;
            if (a.subtaskId !== b.subtaskId) return a.subtaskId - b.subtaskId;
            return a.id - b.id;
        });
        const firstWrongCase = testCases?.find(tc => TARGET_STATUS.includes(tc.status));
        if (!firstWrongCase) {
            this.response.body = { error: 'No failed test case found' };
            return;
        }

        let config = null;
        if (typeof spdoc.config === 'string' && spdoc.config.trim()) {
            try {
                config = yaml.load(spdoc.config as string) as ProblemConfigFile;
            } catch (e) {
                throw new Error('config 解析失败');
            }
        } else if (spdoc.config && typeof spdoc.config === 'object') {
            config = spdoc.config as ProblemConfigFile;
        }

        // const ppdoc = await DocumentModel.get(spdoc.domainId, DocumentModel.TYPE_PROBLEM, spdoc.pid);
        // console.log(config, spdoc, ppdoc);
        let filename = '';
        if (config?.subtasks && firstWrongCase.subtaskId) {
            const subtask = config.subtasks.find(s => s.id === firstWrongCase.subtaskId);
            if (subtask?.cases) {
                const caseIndex = firstWrongCase.id - 1;
                const testcase = subtask.cases[caseIndex];
                if (testcase) {
                    filename = category === 'in' ? testcase.input : testcase.output;
                }
            }
        }
        if (!filename && config?.cases) {
            const caseIndex = firstWrongCase.id - 1;
            const testcase = config.cases[caseIndex];
            if (testcase) {
                filename = category === 'in' ? testcase.input : testcase.output;
            }
        }
        if (!filename && spdoc.data) {
            const datas = spdoc.data;
            const targetId = firstWrongCase.id.toString();
            const pattern = category === 'in'
                ? `^.*?${targetId}\\.in$`
                : `^.*?${targetId}\\\.(out|ans)$`;
            const reg = new RegExp(pattern);
            for (const data of datas) {
                if (reg.test(data.name)) {
                    filename = data.name;
                    break; // 找到第一个匹配项即可
                }
            }
        }

        const subName = firstWrongCase.subtaskId ? `${firstWrongCase.subtaskId}-${firstWrongCase.id}` : `${firstWrongCase.id}`;
        const candidates: string[] = [];
        if (filename) {
            candidates.push(filename);
            if (category === 'out') {
                if (filename.endsWith('.out')) candidates.push(filename.replace(/\.out$/i, '.ans'));
                if (filename.endsWith('.ans')) candidates.push(filename.replace(/\.ans$/i, '.out'));
            }
        } else {
            if (category === 'in') {
                candidates.push(`${subName}.in`, `${firstWrongCase.id}.in`);
            } else {
                candidates.push(
                    `${subName}.out`, `${subName}.ans`,
                    `${firstWrongCase.id}.out`, `${firstWrongCase.id}.ans`
                );
            }
        }
        const prefix = `problem/${spdoc.domainId}/${spdoc.docId}/testdata/`;
        for (const name of candidates) {
            try {
                const key = `${prefix}${name}`;
                this.response.redirect = await StorageModel.signDownloadLink(key, name, false, 'user');
                return;
            } catch { }
        }

        this.response.body = { error: 'File not found' };
    }
}

export async function apply(ctx: Context) {
    ctx.setting.DomainSetting(
        Setting('setting_domain', 'enableDownloadFirst', false, 'boolean',
            'Enable Download First Error Data',
            'Allow users to download the first failed test case data')
    );
    ctx.i18n.load('zh', {
        'Allow users to download the first failed test case data': '允许用户下载首个错误数据',
        'This feature is disabled in this domain': '该功能禁止在此域使用'
    });
    ctx.Route('download_first', '/record/:rid/download-data/:category', DownloadFirstDataHandler, PRIV.PRIV_USER_PROFILE);
}
