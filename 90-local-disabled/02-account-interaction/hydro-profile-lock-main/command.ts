import os from 'os';
import path from 'path';
import fs from 'fs';
import { CAC } from 'cac';
import { MongoClient } from 'mongodb';
import mongoUri from 'mongodb-uri';

function toSafeInt(value: any, name: string) {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isSafeInteger(n)) throw new Error(`Invalid ${name}: ${value}`);
    return n;
}

function maskMongoUrl(url: string) {
    return url.replace(/\\/\\/([^:/?#]+):([^@/?#]+)@/g, '//$1:***@');
}

function loadOptions() {
    const profile = process.env.HYDRO_PROFILE;
    const hydroPath = profile
        ? path.resolve(os.homedir(), '.hydro', 'profiles', profile)
        : path.resolve(os.homedir(), '.hydro');
    const candidate = [
        path.resolve(process.cwd(), 'config.json'),
        path.resolve(hydroPath, 'config.json'),
    ];
    const f = candidate.find((i) => fs.existsSync(i));
    if (!f) return null;
    try {
        return JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch (e) {
        throw new Error(`Failed to parse config file ${f}: ${(e as Error).message}`);
    }
}

async function getMongoUrl() {
    const opts = loadOptions();
    if (!opts) return null;
    let mongourl = `${opts.protocol || 'mongodb'}://`;
    if (opts.username) mongourl += `${opts.username}:${encodeURIComponent(opts.password)}@`;
    mongourl += `${opts.host}:${opts.port}/${opts.name}`;
    if (opts.url || opts.uri) mongourl = opts.url || opts.uri;
    return mongourl;
}

function resolveCollectionName(base: string, opts: any) {
    let name = opts?.prefix ? `${opts.prefix}.${base}` : base;
    if (opts?.collectionMap?.[name]) name = opts.collectionMap[name];
    return name;
}

export function register(cli: CAC) {
    cli.command('reset-user-profile', 'Reset all users profile fields (avatar/bio/qq/gender/school/studentId/phone/displayName/backgroundImage)')
        .option('--yes', 'Actually apply changes (default: dry-run)', { default: false })
        .option('--minUid <minUid>', 'Only affect users with uid >= minUid', { default: 1 })
        .option('--maxUid <maxUid>', 'Only affect users with uid <= maxUid', { default: undefined })
        .option('--limit <limit>', 'Only affect first N matched users (sorted by uid asc)', { default: 0 })
        .option('--avatar <avatar>', 'Set avatar for all users; default is gravatar:<mail> per user', { default: '' })
        .option('--backgroundImage <backgroundImage>', 'Set background image for all users', { default: '/components/profile/backgrounds/1.jpg' })
        .option('--verbose', 'Print detailed filter and update pipeline', { default: false })
        .action(async (options) => {
            const opts = loadOptions() || {};
            const url = await getMongoUrl();
            if (!url) throw new Error('Cannot find MongoDB config (config.json not found?)');

            const minUid = toSafeInt(options.minUid, 'minUid');
            if (minUid < 1) throw new Error('minUid must be >= 1');
            const maxUid = options.maxUid === undefined ? undefined : toSafeInt(options.maxUid, 'maxUid');
            const limit = toSafeInt(options.limit, 'limit');
            if (limit < 0) throw new Error('limit must be >= 0');

            const parsed = mongoUri.parse(url);
            const dbName = parsed.database || 'hydro';
            const userCollectionName = resolveCollectionName('user', opts);

            const client = await MongoClient.connect(url);
            try {
                const db = client.db(dbName);
                const userColl = db.collection(userCollectionName);
                const domainUserCollName = resolveCollectionName('domain.user', opts);
                const domainUserColl = db.collection(domainUserCollName);
                const baseFilter: any = { _id: { $gte: minUid } };
                if (typeof maxUid === 'number') baseFilter._id.$lte = maxUid;

                let filter: any = baseFilter;
                if (limit > 0) {
                    const docs = await userColl.find(baseFilter).project({ _id: 1 }).sort({ _id: 1 }).limit(limit).toArray();
                    filter = { _id: { $in: docs.map((d) => d._id) } };
                }

                const avatarValue = options.avatar ? String(options.avatar) : null;
                const backgroundImage = String(options.backgroundImage || '/components/profile/backgrounds/1.jpg');

                const updatePipeline: any[] = [{
                    $set: {
                        avatar: avatarValue
                            ? avatarValue
                            : { $concat: ['gravatar:', { $ifNull: ['$mail', 'unknown@hydro.local'] }] },
                        bio: null,
                        qq: null,
                        gender: 2,
                        school: '',
                        studentId: '',
                        phone: null,
                        backgroundImage,
                    },
                }];

                const matched = await userColl.countDocuments(filter);
                console.log('Matched users:', matched);
                if (options.verbose) {
                    console.log('MongoDB:', maskMongoUrl(url), `(db=${dbName}, collection=${userCollectionName})`);
                    console.log('Target filter:', JSON.stringify(filter));
                    console.log('Update pipeline:\n', JSON.stringify(updatePipeline, null, 2));
                }

                if (!options.yes) {
                    console.warn('Dry-run only. Re-run with `--yes` to apply.');
                    return;
                }
                const [res, duRes] = await Promise.all([
                    userColl.updateMany(filter, updatePipeline),
                    domainUserColl.updateMany({}, { $set: { displayName: '' } }),
                ]);
                console.log(`Done. user: matched=${res.matchedCount} modified=${res.modifiedCount}`);
                console.log(`      domain.user: matched=${duRes.matchedCount} modified=${duRes.modifiedCount}`);
                console.log('Tip: user cache may take up to ~5 minutes to expire; restart Hydro for immediate effect.');
            } finally {
                await client.close();
            }
        });
}

