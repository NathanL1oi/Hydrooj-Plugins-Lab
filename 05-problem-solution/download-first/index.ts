import { Context, PRIV, Handler, param, Types, RecordModel, ObjectId, ProblemModel, DomainModel, RecordNotFoundError, StorageModel, ProblemNotFoundError, STATUS, yaml, ProblemConfigFile, DocumentModel, ForbiddenError } from 'hydrooj';
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
        const pdoc = await await DocumentModel.get(domainId, DocumentModel.TYPE_PROBLEM, rdoc.pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, rdoc.pid);
        const firstWrongCase = rdoc.testCases?.find(tc => TARGET_STATUS.includes(tc.status));
        if (!firstWrongCase) {
            this.response.body = { error: 'No failed test case found' };
            return;
        }
        let config = null;
        if (typeof pdoc.config === 'string' && pdoc.config.trim()) {
            try {
                config = yaml.load(pdoc.config as string) as ProblemConfigFile;
            } catch (e) {
                throw new Error('config 解析失败');
            }
        }
        let filename = '';
        if (config?.subtasks && firstWrongCase.subtaskId) {
            const subtask = config.subtasks.find(s => s.id === firstWrongCase.subtaskId);
            if (subtask?.cases) {
                // 计算该测试用例在 subtask 中的位置（从0开始）  
                const caseIndex = firstWrongCase.id - 1; // 假设 id 从1开始  
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
        if (!filename && pdoc.data) {
            const datas = pdoc.data;
            let rExp: RegExp = null;
            if (category === 'in') {
                rExp = new RegExp(`.*${firstWrongCase.id}+\\.(in)`);
            } else {
                rExp = new RegExp(`.*${firstWrongCase.id}+\\.(out|ans)`);
            }
            for (let data of datas) {
                if (rExp.test(data.name)) {
                    filename = data.name;
                }
            }
        }
        if (!filename) {
            if (firstWrongCase.subtaskId) filename = `${firstWrongCase.subtaskId}-${firstWrongCase.id}.${category === 'in' ? 'in' : 'out'}`;
            else filename = `${firstWrongCase.id}.${category === 'in' ? 'in' : 'out'}`;
        }
        const target = `problem/${pdoc.domainId}/${pdoc.docId}/testdata/${filename}`;
        try {
            this.response.redirect = await StorageModel.signDownloadLink(
                target,
                filename,
                false,
                'user'
            );
        } catch (e) {
            this.response.body = { error: 'File not found' };
        }
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
