import {
    Context, Handler, PERM, PRIV, Types, param, query,
    UserModel, db, ObjectId, ValidationError, NotFoundError
} from 'hydrooj';
import { readFile } from 'fs/promises';
import calculate from 'hydrooj/src/lib/rating';

// 定义Rating文档接口
export interface RatingDoc {
    _id: ObjectId;
    uid: number;
    rating: number;
    maxRating: number;
    contestCount: number;
    lastUpdate: Date;
}

// 定义Rating历史记录接口
export interface RatingHistoryDoc {
    _id: ObjectId;
    uid: number;
    contestName: string;
    oldRating: number;
    newRating: number;
    rank: number;
    date: Date;
}

// 存档记录接口
export interface RatingArchiveDoc {
    _id: ObjectId;
    contestName: string;
    operationType: 'contest' | 'manual'; // 比赛导入或手动修改
    operationDate: Date;
    participants: Array<{
        uid: number;
        username: string;
        oldRating: number;
        newRating: number;
        rank?: number;
    }>;
    operatorUid?: number; // 操作者ID
    description?: string; // 操作描述
}

// 扩展Hydro的类型定义
declare module 'hydrooj' {
    interface Model {
        rating: typeof RatingModel;
    }
    interface Collections {
        rating: RatingDoc;
        ratingHistory: RatingHistoryDoc;
    }
}

// 获取数据库集合
const ratingColl = db.collection('rating');
const ratingHistoryColl = db.collection('ratingHistory');
const ratingArchiveColl = db.collection('ratingArchive');

// Rating数据模型
export class RatingModel {
    // 获取用户Rating信息
    static async get(uid: number): Promise<RatingDoc | null> {
        return await ratingColl.findOne({ uid });
    }

    // 获取用户Rating排名
    static async getRank(uid: number): Promise<number> {
        const userRating = await this.get(uid);
        if (!userRating) return 0;
        
        const count = await ratingColl.countDocuments({ 
            rating: { $gt: userRating.rating } 
        });
        return count + 1;
    }

    // 获取Rating排行榜（只显示至少参加过1次比赛的用户）
    static async getLeaderboard(page = 1, limit = 50): Promise<RatingDoc[]> {
        return await ratingColl
            .find({ contestCount: { $gt: 0 } }) // 只显示至少参加过1次比赛的用户
            .sort({ rating: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();
    }

    // 获取Rating排行榜总数（只计算至少参加过1次比赛的用户）
    static async getLeaderboardCount(): Promise<number> {
        return await ratingColl.countDocuments({ contestCount: { $gt: 0 } });
    }

    // 更新用户Rating
    static async updateRating(
        uid: number, 
        rating: number, 
        contestName: string, 
        rank: number
    ): Promise<void> {
        // 验证输入参数
        if (uid <= 0) throw new ValidationError('Invalid user ID');
        if (rating < 0 || rating > 5000) throw new ValidationError('Rating must be between 0 and 5000');
        if (!contestName.trim()) throw new ValidationError('Contest name cannot be empty');
        if (rank < 0) throw new ValidationError('Rank must be non-negative');
        
        const currentRating = await this.get(uid);
        const oldRating = currentRating?.rating || 1000; // 默认1000分
        
        // 更新或创建Rating记录
        await ratingColl.updateOne(
            { uid },
            {
                $set: {
                    uid,
                    rating: rating,
                    maxRating: Math.max(currentRating?.maxRating || 1000, rating),
                    lastUpdate: new Date()
                },
                $inc: {
                    contestCount: 1
                }
            },
            { upsert: true }
        );

        // 添加历史记录
        await ratingHistoryColl.insertOne({
            _id: new ObjectId(),
            uid,
            oldRating,
            newRating: rating,
            contestName: contestName.trim(),
            rank,
            date: new Date()
        });
    }

    // 获取用户Rating历史
    static async getHistory(uid: number): Promise<RatingHistoryDoc[]> {
        return await ratingHistoryColl
            .find({ uid })
            .sort({ date: 1 })
            .toArray();
    }

    // 删除用户Rating记录
    static async deleteRating(uid: number): Promise<void> {
        await Promise.all([
            ratingColl.deleteOne({ uid }),
            ratingHistoryColl.deleteMany({ uid })
        ]);
    }

    // 新增：获取所有用户的rating信息（分页）
    static async getAllUsers(page = 1, limit = 50, search?: string): Promise<{users: any[], total: number}> {
        const skip = (page - 1) * limit;
        let query: any = {};
        
        if (search) {
            // 如果有搜索条件，需要联合查询用户表
            const userQuery = search.match(/^\d+$/) 
                ? { _id: parseInt(search) }
                : { $or: [
                    { uname: new RegExp(search, 'i') },
                    { mail: new RegExp(search, 'i') }
                ]};
            
            const users = await UserModel.getMulti(userQuery).toArray();
            const uids = users.map(u => u._id);
            query = { uid: { $in: uids } };
        }

        const [ratings, total] = await Promise.all([
            ratingColl.find(query).sort({ rating: -1 }).skip(skip).limit(limit).toArray(),
            ratingColl.countDocuments(query)
        ]);

        // 获取用户信息
        const uids = ratings.map(r => r.uid);
        const users = await UserModel.getMulti({ _id: { $in: uids } }).toArray();
        const userMap = new Map(users.map(u => [u._id, u]));

        const result = ratings.map(rating => ({
            ...rating,
            user: userMap.get(rating.uid)
        }));

        return { users: result, total };
    }

    // 新增：初始化用户rating
    static async initializeUserRating(uid: number, initialRating = 1000): Promise<void> {
        // 删除现有记录
        await this.deleteRating(uid);
        
        // 创建新的初始记录
        await ratingColl.insertOne({
            _id: new ObjectId(),
            uid,
            rating: initialRating,
            maxRating: initialRating,
            contestCount: 0,
            lastUpdate: new Date()
        });
    }

    // 新增：批量初始化所有用户rating为指定值
    static async initializeAllUsersRating(initialRating = 1000): Promise<number> {
        // 获取所有用户
        const users = await UserModel.getMulti({}).toArray();
        let count = 0;

        for (const user of users) {
            await this.initializeUserRating(user._id, initialRating);
            count++;
        }

        return count;
    }

    // 新增：删除特定比赛的rating变化记录
    static async removeContestRating(uid: number, contestName: string, operatorUid?: number): Promise<boolean> {
        // 查找该比赛的历史记录
        const historyRecord = await ratingHistoryColl.findOne({ uid, contestName });
        if (!historyRecord) return false;

        // 获取用户信息用于archive
        const user = await UserModel.getById('system', uid);
        const username = user?.uname || `User${uid}`;
        
        // 创建archive记录
        await this.createArchive(
            `Manual-Remove-${contestName}-${Date.now()}`,
            'manual',
            [{
                uid,
                username,
                oldRating: historyRecord.newRating,
                newRating: historyRecord.oldRating, // 恢复到删除前的rating
                rank: historyRecord.rank
            }],
            operatorUid,
            `Manually removed contest record: ${contestName} for user ${username}`
        );

        // 删除历史记录
        await ratingHistoryColl.deleteOne({ _id: historyRecord._id });

        // 重新计算用户的rating
        await this.recalculateUserRating(uid);
        
        return true;
    }

    // 新增：修改特定比赛的rating变化
    static async modifyContestRating(
        uid: number, 
        contestName: string, 
        newRating: number, 
        newRank?: number,
        operatorUid?: number
    ): Promise<boolean> {
        const historyRecord = await ratingHistoryColl.findOne({ uid, contestName });
        if (!historyRecord) return false;

        // 获取用户信息用于archive
        const user = await UserModel.getById('system', uid);
        const username = user?.uname || `User${uid}`;
        
        // 创建archive记录（记录修改前的状态）
        await this.createArchive(
            `Manual-Modify-${contestName}-${Date.now()}`,
            'manual',
            [{
                uid,
                username,
                oldRating: historyRecord.newRating,
                newRating: newRating,
                rank: newRank || historyRecord.rank
            }],
            operatorUid,
            `Manually modified contest record: ${contestName} for user ${username} (${historyRecord.newRating} -> ${newRating})`
        );

        // 更新历史记录
        const updateData: any = { newRating };
        if (newRank !== undefined) updateData.rank = newRank;
        
        await ratingHistoryColl.updateOne(
            { _id: historyRecord._id },
            { $set: updateData }
        );

        // 重新计算用户的rating
        await this.recalculateUserRating(uid);
        
        return true;
    }

    // 新增：重新计算用户rating（基于历史记录）
    static async recalculateUserRating(uid: number): Promise<void> {
        const history = await ratingHistoryColl
            .find({ uid })
            .sort({ date: 1 })
            .toArray();

        if (history.length === 0) {
            // 如果没有历史记录，恢复到默认的1000分
            await ratingColl.updateOne(
                { uid },
                {
                    $set: {
                        rating: 1000,
                        maxRating: 1000,
                        contestCount: 0,
                        lastUpdate: new Date()
                    }
                },
                { upsert: true }
            );
            return;
        }

        // 计算最终rating和最大rating
        const finalRating = history[history.length - 1].newRating;
        const maxRating = Math.max(...history.map(h => h.newRating));

        // 更新rating记录
        await ratingColl.updateOne(
            { uid },
            {
                $set: {
                    rating: finalRating,
                    maxRating,
                    contestCount: history.length,
                    lastUpdate: new Date()
                }
            },
            { upsert: true }
        );
    }



    // 批量处理比赛结果（使用标准CF算法）
    static async processContestResults(contestName: string, participants: Array<{uid: number, username: string, rank: number}>, operatorUid?: number): Promise<void> {
        // 过滤有效参与者（有排名且有提交的选手）
        const validParticipants = participants.filter(p => p.rank > 0);
        const totalParticipants = validParticipants.length;
        
        if (totalParticipants === 0) {
            throw new ValidationError('No valid participants found');
        }

        // 获取所有参与者的当前rating
        const userRatings = new Map<number, number>();
        const ratingInputUsers = [];
        
        for (const participant of validParticipants) {
            const ratingDoc = await this.get(participant.uid);
            const oldRating = ratingDoc?.rating || 1000; // 新用户默认1000分
            userRatings.set(participant.uid, oldRating);
            
            ratingInputUsers.push({
                uid: participant.uid,
                rank: participant.rank,
                old: oldRating
            });
        }

        // 使用标准CF算法计算新rating
        const ratingResults = calculate(ratingInputUsers);
        
        // 准备存档数据
        const archiveParticipants = [];
        
        // 更新每个参与者的rating
        for (let i = 0; i < validParticipants.length; i++) {
            const participant = validParticipants[i];
            const result = ratingResults.find(r => r.uid === participant.uid);
            
            if (result) {
                const oldRating = userRatings.get(participant.uid) || 1000;
                const newRating = Math.max(0, Math.round(result.new));
                
                archiveParticipants.push({
                    uid: participant.uid,
                    username: participant.username,
                    oldRating,
                    newRating,
                    rank: participant.rank
                });
                
                await this.updateRating(participant.uid, newRating, contestName, participant.rank);
            }
        }

        // 创建存档记录
        await this.createArchive(contestName, 'contest', archiveParticipants, operatorUid);
    }

    // 创建存档记录
    static async createArchive(
        contestName: string, 
        operationType: 'contest' | 'manual', 
        participants: Array<{uid: number, username: string, oldRating: number, newRating: number, rank?: number}>,
        operatorUid?: number,
        description?: string
    ): Promise<void> {
        await ratingArchiveColl.insertOne({
            contestName,
            operationType,
            operationDate: new Date(),
            participants,
            operatorUid,
            description
        });
    }

    // 获取存档列表
    static async getArchives(page = 1, limit = 20): Promise<{archives: RatingArchiveDoc[], total: number}> {
        const total = await ratingArchiveColl.countDocuments();
        const archives = await ratingArchiveColl
            .find({})
            .sort({ operationDate: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();
        
        return { archives, total };
    }

    // 撤回最近一次操作
    static async revertLastOperation(): Promise<boolean> {
        const lastArchive = await ratingArchiveColl
            .findOne({}, { sort: { operationDate: -1 } });
        
        if (!lastArchive) {
            return false;
        }

        // 恢复所有参与者的rating
        for (const participant of lastArchive.participants) {
            // 删除相关的历史记录
            await ratingHistoryColl.deleteOne({
                uid: participant.uid,
                contestName: lastArchive.contestName
            });
            
            // 恢复rating
            await ratingColl.updateOne(
                { uid: participant.uid },
                {
                    $set: {
                        rating: participant.oldRating,
                        lastUpdate: new Date()
                    }
                }
            );
            
            // 重新计算用户rating（基于剩余历史记录）
            await this.recalculateUserRating(participant.uid);
        }

        // 删除存档记录
        await ratingArchiveColl.deleteOne({ _id: lastArchive._id });
        
        return true;
    }

    // 手动修改rating（支持变化值）
    static async updateRatingByDelta(uid: number, delta: number, contestName: string, operatorUid?: number): Promise<void> {
        const currentRating = await this.get(uid);
        const oldRating = currentRating?.rating || 1000;
        const newRating = Math.max(0, oldRating + delta);
        
        // 获取用户信息
        const user = await UserModel.getById('system', uid);
        const username = user?.uname || `User${uid}`;
        
        // 创建存档记录
        await this.createArchive(
            contestName, 
            'manual', 
            [{
                uid,
                username,
                oldRating,
                newRating
            }],
            operatorUid,
            `Manual rating change: ${delta > 0 ? '+' : ''}${delta}`
        );
        
        // 更新rating
        await this.updateRating(uid, newRating, contestName, 0);
    }
}

// Rating排行榜处理器
class RatingListHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        // 验证页码
        if (page < 1) {
            throw new ValidationError('Page number must be positive');
        }
        
        const limit = 50;
        const skip = (page - 1) * limit;
        
        // 只查询至少参加过1次比赛的用户
        const query = { contestCount: { $gt: 0 } };
        
        const [ratings, total] = await Promise.all([
            ratingColl.find(query).sort({ rating: -1 }).skip(skip).limit(limit).toArray(),
            ratingColl.countDocuments(query)
        ]);

        // 获取用户信息
        const uids = ratings.map((r) => r.uid);
        // 使用当前 domainId 获取用户字典，返回值为以 uid 为键的字典
        const users = await UserModel.getList(domainId, uids);

        const ratingList = ratings.map((rating, index) => ({
            ...rating,
            rank: skip + index + 1,
            // 从字典中直接取用户信息，避免对字典使用 .map 导致类型错误
            user: users[rating.uid]
        }));

        this.response.template = 'rating_list.html';
        this.response.body = {
            leaderboard: ratingList,
            page,
            pages: Math.ceil(total / limit),
            total
        };
    }
}

// 用户Rating详情处理器
class UserRatingHandler extends Handler {
    @param('uid', Types.PositiveInt)
    async get(domainId: string, uid: number) {
        // 验证uid的有效性
        if (uid <= 0) {
            throw new ValidationError('Invalid user ID');
        }
        
        const user = await UserModel.getById(domainId, uid);
        if (!user) throw new NotFoundError('User not found');

        const [rating, history] = await Promise.all([
            RatingModel.get(uid),
            RatingModel.getHistory(uid)
        ]);
        
        // 计算排名
        const rank = rating ? await ratingColl.countDocuments({ rating: { $gt: rating.rating } }) + 1 : 0;

        this.response.template = 'user_rating.html';
        this.response.body = {
            udoc: user,
            rating: rating || { rating: 1000, maxRating: 1000, contestCount: 0 },
            rank,
            history
        };
    }
}

// 管理员Rating管理处理器
class RatingManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        this.response.template = 'rating_manage.html';
        this.response.body = {};
    }

    @param('uid', Types.PositiveInt)
    @param('ratingDelta', Types.Int) // 改为支持正负数的变化值
    @param('contestName', Types.String)
    async postUpdateRating(domainId: string, uid: number, ratingDelta: number, contestName: string) {
        // 验证ratingDelta范围
        if (Math.abs(ratingDelta) > 1000) {
            throw new ValidationError('Rating change must be between -1000 and +1000');
        }
        
        // 验证contestName不为空
        if (!contestName.trim()) {
            throw new ValidationError('Contest name cannot be empty');
        }
        
        const user = await UserModel.getById(domainId, uid);
        if (!user) throw new NotFoundError('User not found');

        // 使用新的delta更新方法
        await RatingModel.updateRatingByDelta(uid, ratingDelta, contestName.trim(), this.user._id);
        this.response.redirect = this.url('rating_manage');
    }
}

// Contest Rating Compute处理器（顶层定义）
class ContestRatingComputeHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        // 获取存档记录用于显示
        const { archives, total } = await RatingModel.getArchives(1, 10);
        this.response.template = 'contest_rating_compute.html';
        this.response.body = { archives, total };
    }

    @param('csvFile', Types.File, true)
    @param('csvContent', Types.String, true)
    @param('contestName', Types.String)
    async postImportContest(domainId: string, csvFile?: any, csvContent?: string, contestName?: string) {
        if (!contestName?.trim()) {
            throw new ValidationError('Contest name cannot be empty');
        }

        try {
            let csvData: string;
            // 兼容从 this.request.files 读取文件（如果装饰器未提供 csvFile）
            const uploadedFile = csvFile || this.request.files?.csvFile;
            const bodyCsvContent: string | undefined = csvContent || this.request.body?.csvContent;
            
            // 处理文件上传或文本内容
            if (uploadedFile) {
                // 支持两种文件对象：具有 read() 方法的封装类型，或 formidable 解析出的文件对象
                if (typeof uploadedFile.read === 'function') {
                    const buffer = await uploadedFile.read();
                    csvData = buffer.toString('utf-8');
                } else if (uploadedFile.filepath) {
                    csvData = await readFile(uploadedFile.filepath, 'utf-8');
                } else {
                    throw new ValidationError('Invalid CSV file');
                }
            } else if (typeof bodyCsvContent === 'string' && bodyCsvContent.trim()) {
                // 使用传统的文本内容方式
                csvData = bodyCsvContent;
            } else {
                throw new ValidationError('Either CSV file or CSV content must be provided');
            }
            // 使用更健壮的CSV解析方法，正确处理引号内的换行符
            const parseCSV = (csvText: string) => {
                const rows: string[][] = [];
                let currentRow: string[] = [];
                let currentField = '';
                let inQuotes = false;
                let i = 0;
                
                while (i < csvText.length) {
                    const char = csvText[i];
                    
                    if (char === '"') {
                        if (inQuotes && csvText[i + 1] === '"') {
                            // 转义的引号
                            currentField += '"';
                            i += 2;
                            continue;
                        }
                        inQuotes = !inQuotes;
                    } else if (char === ',' && !inQuotes) {
                        currentRow.push(currentField.trim());
                        currentField = '';
                    } else if ((char === '\n' || char === '\r') && !inQuotes) {
                        // 只有在不在引号内时才结束行
                        currentRow.push(currentField.trim());
                        if (currentRow.some(field => field !== '')) {
                            rows.push(currentRow);
                        }
                        currentRow = [];
                        currentField = '';
                        // 跳过 \r\n 中的 \n
                        if (char === '\r' && csvText[i + 1] === '\n') {
                            i++;
                        }
                    } else if (char === '\n' && inQuotes) {
                        // 在引号内的换行符保留为空格，避免多行字段问题
                        currentField += ' ';
                    } else if (char === '\r' && inQuotes) {
                        // 忽略引号内的回车符
                        // 不添加任何内容
                    } else {
                        currentField += char;
                    }
                    i++;
                }
                
                // 处理最后一个字段
                if (currentField !== '' || currentRow.length > 0) {
                    currentRow.push(currentField.trim());
                    if (currentRow.some(field => field !== '')) {
                        rows.push(currentRow);
                    }
                }
                
                return rows;
            };

            const rows = parseCSV(csvData.trim());
            if (rows.length < 2) {
                throw new ValidationError('CSV file must contain at least header and one data row');
            }

            // 解析CSV头部，找到关键列的索引
            const header = rows[0];
            const rankIndex = header.findIndex(col => col === '#' || col.includes('排名'));
            const usernameIndex = header.findIndex(col => col === '用户' || col.includes('用户'));
            
            // 找到所有题目相关的列（包括题目列和罚时列）
            const problemColumns: number[] = [];
            for (let i = 0; i < header.length; i++) {
                const col = header[i];
                // 匹配题目列（如 #1, #2, #3, #4）和罚时列（如 #1 罚时, #2 罚时）
                if (col.match(/^#\d+/) || col.includes('罚时')) {
                    problemColumns.push(i);
                }
            }
            
            if (rankIndex === -1 || usernameIndex === -1) {
                throw new ValidationError('CSV must contain rank (#) and username (用户) columns');
            }

            // 解析参赛者数据
            const participants: Array<{uid: number, username: string, rank: number}> = [];
            let totalUsers = 0;
            let filteredUsers = 0;
            
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const rank = parseInt(row[rankIndex]);
                const username = row[usernameIndex];
                totalUsers++;
                
                // 跳过无效排名（0表示未参与排名）
                if (!rank || rank === 0) {
                    filteredUsers++;
                    continue;
                }
                
                // 检查是否有提交记录（检查所有题目相关列是否都为空）
                let hasSubmission = false;
                for (const colIndex of problemColumns) {
                    const cellValue = row[colIndex];
                    // 如果任何一个题目相关列有内容（不为空、不为0且不为空字符串），说明有提交
                    if (cellValue && cellValue.trim() !== '' && cellValue.trim() !== '0' && cellValue.trim() !== '0.0') {
                        hasSubmission = true;
                        break;
                    }
                }
                
                // 如果所有题目相关列都为空或为0，说明没有提交
                if (!hasSubmission) {
                    filteredUsers++;
                    continue;
                }
                
                // 根据用户名查找用户ID
                const user = await UserModel.getByUname(domainId, username);
                if (user) {
                    participants.push({
                        uid: user._id,
                        username: username,
                        rank: rank
                    });
                } else {
                    filteredUsers++;
                }
            }

            if (participants.length === 0) {
                throw new ValidationError('No valid participants with submissions found in CSV');
            }

            // 处理比赛结果并更新rating
            await RatingModel.processContestResults(contestName.trim(), participants, this.user._id);
            
            // 重定向到管理界面
            this.response.redirect = this.url('contest_rating_compute');
            
        } catch (error) {
            // 保留框架 ValidationError 的参数化信息，避免出现 "Field {0}" 未格式化的问题
            if (error instanceof ValidationError) throw error;
            throw new ValidationError(`Failed to process CSV: ${error?.message ?? String(error)}`);
        }
    }

    // 撤回最近一次操作
    async postRevertLast(domainId: string) {
        const success = await RatingModel.revertLastOperation();
        if (!success) {
            throw new ValidationError('No operation to revert or revert failed');
        }
        this.response.redirect = this.url('contest_rating_compute');
    }
}

// Rating 统计 API 处理器（顶层定义）
class RatingStatsHandler extends Handler {
    async get() {
        const [totalUsers, avgRating, maxRating] = await Promise.all([
            ratingColl.countDocuments({}),
            ratingColl.aggregate([
                { $group: { _id: null, avgRating: { $avg: '$rating' } } }
            ]).toArray(),
            ratingColl.findOne({}, { sort: { rating: -1 } })
        ]);

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const activeUsers = await ratingColl.countDocuments({
            lastUpdate: { $gte: thirtyDaysAgo }
        });

        this.response.body = {
            totalUsers,
            avgRating: avgRating[0]?.avgRating || 0,
            maxRating: maxRating?.rating || 0,
            activeUsers
        };
    }
}

// 用户 Rating JSON API（用户详情页前端拉取）
class RatingUserApiHandler extends Handler {
    @param('uid', Types.PositiveInt)
    async get(domainId: string, uid: number) {
        if (uid <= 0) throw new ValidationError('Invalid user ID');
        const [rating, history] = await Promise.all([
            RatingModel.get(uid),
            RatingModel.getHistory(uid),
        ]);
        const rank = await RatingModel.getRank(uid);
        this.response.body = {
            rating: rating || { rating: 1000, maxRating: 1000, contestCount: 0 },
            history,
            rank,
        };
    }
}

// 新增：获取用户信息的API（用于前端显示用户名）
class UserInfoApiHandler extends Handler {
    @param('uid', Types.PositiveInt)
    async get(domainId: string, uid: number) {
        const user = await UserModel.getById(domainId, uid);
        
        if (!user) {
            this.response.body = { error: 'User not found' };
            return;
        }
        
        this.response.body = {
            uid,
            username: user.uname,
            displayName: user.displayName || user.uname
        };
    }
}

// 新增：用户Rating管理处理器
class UserRatingManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    @query('page', Types.PositiveInt, true)
    @query('search', Types.String, true)
    async get(domainId: string, page = 1, search?: string) {
        const limit = 20;
        const { users, total } = await RatingModel.getAllUsers(page, limit, search);
        
        this.response.template = 'user_rating_manage.html';
        this.response.body = {
            users,
            page,
            pages: Math.ceil(total / limit),
            total,
            search: search || ''
        };
    }

    @param('operation', Types.String)
    async post(domainId: string, operation: string) {
        if (operation === 'initialize_user') {
            return this.postInitializeUser(domainId);
        } else if (operation === 'initialize_all') {
            return this.postInitializeAll(domainId);
        } else if (operation === 'remove_contest') {
            return this.postRemoveContest(domainId);
        } else if (operation === 'modify_contest') {
            return this.postModifyContest(domainId);
        } else {
            throw new ValidationError('Invalid operation');
        }
    }

    // 初始化单个用户rating
    async postInitializeUser(domainId: string) {
        const uid = parseInt(this.request.body.uid);
        const initialRating = parseInt(this.request.body.initialRating) || 1000;
        
        const user = await UserModel.getById(domainId, uid);
        if (!user) throw new NotFoundError('User not found');

        await RatingModel.initializeUserRating(uid, initialRating);
        this.response.redirect = this.url('user_rating_manage');
    }

    // 批量初始化所有用户rating
    async postInitializeAll(domainId: string) {
        const initialRating = parseInt(this.request.body.initialRating) || 1000;
        const count = await RatingModel.initializeAllUsersRating(initialRating);
        this.response.redirect = this.url('user_rating_manage');
    }

    // 删除用户特定比赛的rating记录
    async postRemoveContest(domainId: string) {
        const uid = parseInt(this.request.body.uid);
        const contestName = this.request.body.contestName;
        
        const success = await RatingModel.removeContestRating(uid, contestName, this.user._id);
        if (!success) {
            throw new NotFoundError('Contest record not found');
        }
        this.response.redirect = this.url('user_rating_manage');
    }

    // 修改用户特定比赛的rating记录
    async postModifyContest(domainId: string) {
        const uid = parseInt(this.request.body.uid);
        const contestName = this.request.body.contestName;
        const newRating = parseInt(this.request.body.newRating);
        const newRank = this.request.body.newRank ? parseInt(this.request.body.newRank) : undefined;
        
        const success = await RatingModel.modifyContestRating(uid, contestName, newRating, newRank, this.user._id);
        if (!success) {
            throw new NotFoundError('Contest record not found');
        }
        this.response.redirect = this.url('user_rating_manage');
    }
}

// 插件应用函数
export async function apply(ctx: Context) {
    
    // 注册路由
    // 公共访问：排行榜与用户评级页
    ctx.Route('rating_list', '/rating', RatingListHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('user_rating', '/user/:uid/rating', UserRatingHandler);
    ctx.Route('rating_manage', '/manage/rating', RatingManageHandler, PRIV.PRIV_EDIT_SYSTEM);

    // 新增：用户Rating管理路由
    ctx.Route('user_rating_manage', '/manage/user-rating', UserRatingManageHandler, PRIV.PRIV_EDIT_SYSTEM);

    // 顶层类定义：RatingBatchImportHandler 与 RatingStatsHandler

    ctx.Route('contest_rating_compute', '/manage/rating/contest', ContestRatingComputeHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('rating_stats', '/api/rating/stats', RatingStatsHandler, PERM.PERM_VIEW_RANKING);
    // 用户评级数据 API 公开访问，便于用户详情页加载
    ctx.Route('rating_user_api', '/api/rating/user/:uid', RatingUserApiHandler);
    // 新增：用户信息API，用于获取用户名
    ctx.Route('user_info_api', '/api/user/:uid/info', UserInfoApiHandler);

    // 顶部导航添加 Rating 菜单（使用 UI 注入机制）
    // 导航项默认公开显示
    ctx.injectUI('Nav', 'rating_list', { prefix: 'rating' });

    // 添加管理界面菜单到侧边栏
    ctx.injectUI('ControlPanel', 'rating_manage', { icon: 'chart-line' });
    // 新增：添加Contest Rating Compute菜单到侧边栏
    ctx.injectUI('ControlPanel', 'contest_rating_compute', { icon: 'trophy' });
    // 新增：添加用户Rating管理菜单到侧边栏
    ctx.injectUI('ControlPanel', 'user_rating_manage', { icon: 'users' });

    // 添加国际化支持
    ctx.i18n.load('zh', {
        'rating_manage': 'Rating修改',
        'contest_rating_compute': '比赛Rating计算',
        'user_rating_manage': '用户Rating管理',
        'rating_list': 'Rating排行榜',
        'Rating Leaderboard': 'Rating排行榜',
        'Rating Management': 'Rating管理',
        'Contest Rating Compute': '比赛Rating计算',
        'User Rating Management': '用户Rating管理'
    });
    
    ctx.i18n.load('en', {
        'rating_manage': 'Rating Management',
        'contest_rating_compute': 'Contest Rating Compute',
        'user_rating_manage': 'User Rating Management',
        'rating_list': 'Rating Leaderboard',
        'Rating Leaderboard': 'Rating Leaderboard',
        'Rating Management': 'Rating Management',
        'Contest Rating Compute': 'Contest Rating Compute',
        'User Rating Management': 'User Rating Management'
    });

    // 监听比赛结束事件，自动更新Rating（示例）
    ctx.on('contest/finish', async (domainId, tid, tdoc) => {
        // 这里可以添加自动计算Rating的逻辑
        // 根据比赛结果更新参赛者的Rating
        console.log(`Contest ${tid} finished, updating ratings...`);
    });
}

// 注册Rating模型到全局
global.Hydro.model.rating = RatingModel;