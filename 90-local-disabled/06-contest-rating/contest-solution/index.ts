import { ContestModel, ContestNotAttendedError, Context, FileInfo, FileLimitExceededError, FileUploadError, ForbiddenError, ObjectId, OplogModel, param, PERM, post, randomstring, StorageModel, SystemModel, Tdoc, Types, UserModel, ValidationError } from 'hydrooj';
import { ContestDetailBaseHandler } from 'hydrooj/src/handler/contest';
import { pick } from 'lodash';

declare module 'hydrooj/src/interface' {
    interface Tdoc {
        solution_files?: FileInfo[];
        solution_content?: string;
    }
}

class ContestSolutionHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        if (!ContestModel.isDone(this.tdoc, this.tsdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
            throw new ForbiddenError('比赛未结束');
        }
        if (!this.tsdoc?.attend && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) throw new ContestNotAttendedError(domainId, tid);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const solContent = (this.tdoc.solution_content || '')
            .replace(/\(file:\/\//g, `(./solution/file/`)
            .replace(/="file:\/\//g, `="./solution/file/`);
        const udoc = await UserModel.getById(domainId, this.tdoc.owner);
        this.response.pjax = 'partials/files.html';
        this.response.template = 'contest_solution.html';
        this.response.body = {
            tdoc: { ...this.tdoc, solContent },
            tsdoc: this.tsdoc,
            files: this.tdoc.solution_files || [],
            urlForFile: (filename: string) => this.url('contest_solution_file', { tid, filename }),
            udoc,
        };
    }

    @param('tid', Types.ObjectId)
    @param('content', Types.Content)
    async postUpdate(domainId: string, tid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_EDIT_CONTEST);
        await ContestModel.edit(domainId, tid, { solution_content: content });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        this.checkPerm(PERM.PERM_EDIT_CONTEST);
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.tdoc.solution_files || []).map((i) => i.size)) + file.size;
        if (size >= SystemModel.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        filename ||= file.originalFilename || randomstring(16);
        await StorageModel.put(`contest-solution/${domainId}/${tid}/${filename}`, file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(`contest-solution/${domainId}/${tid}/${filename}`);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        await ContestModel.edit(domainId, tid, { solution_files: [...(this.tdoc.solution_files || []), payload] });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        this.checkPerm(PERM.PERM_EDIT_CONTEST);
        await Promise.all([
            StorageModel.del(files.map((t) => `contest-solution/${domainId}/${tid}/${t}`), this.user._id),
            ContestModel.edit(domainId, tid, {
                solution_files: (this.tdoc.solution_files || []).filter((i) => !files.includes(i.name))
            }),
        ]);
        this.back();
    }
}

class ContestSolutionFileHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, tid: ObjectId, filename: string, noDisposition = false) {
        this.response.addHeader('Cache-Control', 'public');
        const target = `contest-solution/${domainId}/${tid}/${filename}`;
        const file = await StorageModel.getMeta(target);
        await OplogModel.log(this, 'download.file.contest.solution', {
            target,
            size: file?.size || 0,
        });
        this.response.redirect = await StorageModel.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export const description = '比赛题解';

export async function apply(ctx: Context) {
    ctx.Route('contest_solution', '/contest/:tid/solution', ContestSolutionHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_solution_file', '/contest/:tid/solution/file/:filename', ContestSolutionFileHandler, PERM.PERM_VIEW_CONTEST);
    ctx.i18n.load('zh', {
        contest_solution: "比赛题解",
    });

    ctx.on('contest/del', async (domainId: string, tid: ObjectId) => {
        // console.log('delete');
        try {
            const solutionFiles = await StorageModel.list(`contest-solution/${domainId}/${tid}`);
            if (solutionFiles.length > 0) {
                await StorageModel.del(solutionFiles.map(file => file.path));
            }
        } catch (error) {
            console.error(`Failed to delete solution files for contest ${tid}:`, error);
        }
    });
}
