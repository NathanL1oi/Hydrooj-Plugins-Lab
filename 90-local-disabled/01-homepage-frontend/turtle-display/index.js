const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const hydro = require('hydrooj');

const { db, Logger, Schema, SystemModel } = hydro;

const logger = new Logger('turtle-display');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const GHOSTSCRIPT_TIMEOUT_MS = 4000;
const IMAGE_CACHE_LIMIT = 128;
const GOC_LANG = 'cc.goc';
const HEADER_PATH = path.join(__dirname, 'public', 'goc.h');

const imageCache = new Map();

function rememberImage(key, value) {
    if (imageCache.size >= IMAGE_CACHE_LIMIT) {
        imageCache.delete(imageCache.keys().next().value);
    }
    imageCache.set(key, value);
}

function convertEpsToPng(eps) {
    const cacheKey = crypto.createHash('sha1').update(eps).digest('hex');
    const cached = imageCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
        const gs = spawn('gs', [
            '-q',
            '-dSAFER',
            '-dBATCH',
            '-dNOPAUSE',
            '-sPAPERSIZE=letter',
            '-dFIXEDMEDIA',
            '-sDEVICE=png16m',
            '-r72',
            '-sOutputFile=-',
            '-',
        ]);
        const chunks = [];
        let total = 0;
        let closed = false;
        const timer = setTimeout(() => {
            if (closed) return;
            closed = true;
            gs.kill();
            reject(new Error(`Ghostscript conversion timed out (${GHOSTSCRIPT_TIMEOUT_MS}ms)`));
        }, GHOSTSCRIPT_TIMEOUT_MS);

        gs.stdout.on('data', (chunk) => {
            if (closed) return;
            total += chunk.length;
            if (total > MAX_IMAGE_BYTES) {
                closed = true;
                clearTimeout(timer);
                gs.kill();
                reject(new Error(`Image size exceeded limit (${MAX_IMAGE_BYTES} bytes)`));
                return;
            }
            chunks.push(chunk);
        });
        gs.on('error', (err) => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            reject(err);
        });
        gs.on('close', (code) => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Ghostscript exited with code ${code}`));
                return;
            }
            const buffer = Buffer.concat(chunks);
            const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
            const offset = buffer.indexOf(pngHeader);
            const png = (offset >= 0 ? buffer.subarray(offset) : buffer).toString('base64');
            rememberImage(cacheKey, png);
            resolve(png);
        });
        gs.stdin.on('error', () => {});
        gs.stdin.write(eps);
        gs.stdin.end();
    });
}

function messageText(message) {
    if (typeof message === 'string') return message;
    if (message && typeof message.message === 'string') return message.message;
    return '';
}

function installRecordPreview(ctx) {
    const updateRecord = async (rdoc) => {
        try {
            if (!Array.isArray(rdoc.testCases) || !rdoc.testCases.length) return;
            if (messageText(rdoc.testCases[1]?.message).startsWith('hydro:')) return;
            const epsCase = rdoc.testCases.find((item) => messageText(item?.message).includes('%!PS-Adobe-3.0 EPSF-3.0'));
            if (!epsCase) return;

            const png = `hydro:${await convertEpsToPng(messageText(epsCase.message))}`;
            const update = rdoc.testCases.length < 2
                ? { $push: { testCases: { id: 2, subtaskId: 0, status: 1, score: 0, time: 0, memory: 0, message: png } } }
                : { $set: { 'testCases.1.message': png } };
            await db.collection('record').updateOne({ _id: rdoc._id }, update);
            const next = await db.collection('record').findOne({ _id: rdoc._id });
            if (next) ctx.broadcast('record/change', next);
        } catch (err) {
            logger.error('Failed to update record preview:', err);
        }
    };
    ctx.on('record/judge', updateRecord);
    ctx.on('record/change', updateRecord);
}

function gocRuntimePrefix() {
    return String.raw`import math
import turtle

turtle.setup(width=800, height=800)
turtle.speed(0)
turtle.tracer(False)
turtle.hideturtle()
turtle.pensize(2)
turtle.setheading(90)

_GOC_COLORS = [
    '#000', '#F00', '#00F', '#0F0', '#0FF', '#FF0', '#F0F', '#888',
    '#AAA', '#F6B', '#008', '#060', '#48B', '#841', '#244', '#FFF',
]

def _goc_set_color(index):
    turtle.color(_GOC_COLORS[int(index) % len(_GOC_COLORS)])

def _goc_restore(pos, heading, was_down):
    turtle.penup()
    turtle.goto(pos)
    turtle.setheading(heading)
    if was_down:
        turtle.pendown()
    else:
        turtle.penup()

def _goc_rect(width, height, fill=False):
    pos = turtle.position()
    heading = turtle.heading()
    was_down = turtle.isdown()
    x, y = pos
    turtle.penup()
    turtle.goto(x - width / 2.0, y - height / 2.0)
    turtle.setheading(0)
    if fill:
        turtle.begin_fill()
    else:
        turtle.pendown()
    for _ in range(2):
        turtle.forward(width)
        turtle.left(90)
        turtle.forward(height)
        turtle.left(90)
    if fill:
        turtle.end_fill()
    _goc_restore(pos, heading, was_down)

def _goc_circle(radius, fill=False):
    pos = turtle.position()
    heading = turtle.heading()
    was_down = turtle.isdown()
    x, y = pos
    turtle.penup()
    turtle.goto(x, y - radius)
    turtle.setheading(0)
    if fill:
        turtle.begin_fill()
    else:
        turtle.pendown()
    turtle.circle(radius)
    if fill:
        turtle.end_fill()
    _goc_restore(pos, heading, was_down)

def _goc_ellipse(rx, ry, fill=False):
    pos = turtle.position()
    heading = turtle.heading()
    was_down = turtle.isdown()
    angle = math.radians(heading)
    ca, sa = math.cos(angle), math.sin(angle)
    points = []
    for i in range(97):
        t = math.tau * i / 96
        x = rx * math.cos(t)
        y = ry * math.sin(t)
        points.append((pos[0] + x * ca - y * sa, pos[1] + x * sa + y * ca))
    turtle.penup()
    turtle.goto(points[0])
    if fill:
        turtle.begin_fill()
    else:
        turtle.pendown()
    for point in points[1:]:
        turtle.goto(point)
    if fill:
        turtle.end_fill()
    _goc_restore(pos, heading, was_down)

_goc_set_color(0)
`;
}

function buildCompileCommand() {
    const header = fs.readFileSync(HEADER_PATH, 'utf8');
    const base64Header = Buffer.from(header, 'utf8').toString('base64');
    return `/bin/bash -c "python3 -c 'import base64,pathlib; pathlib.Path(\\"goc.h\\").write_bytes(base64.b64decode(\\"${base64Header}\\"))' && /usr/bin/g++ -Wall -std=c++11 -O2 -o foo foo.cc -lm -I. -I/include"`;
}

function buildExecuteCommand() {
    const prefix = Buffer.from(gocRuntimePrefix(), 'utf8').toString('base64');
    const suffix = Buffer.from([
        'turtle.update()',
        "print(turtle.getcanvas().postscript(colormode='color', x=-400, y=-400, width=800, height=800))",
        '',
    ].join('\n'), 'utf8').toString('base64');
    return `/bin/bash -c "python3 -c 'import base64,pathlib,subprocess; p=pathlib.Path(\\"foo.py\\"); p.write_bytes(base64.b64decode(\\"${prefix}\\")); out=subprocess.check_output([\\"./foo\\"]); p.write_bytes(p.read_bytes()+out+b\\"\\\\n\\"+base64.b64decode(\\"${suffix}\\"))' && xvfb-run -a python3 foo.py"`;
}

function buildGocLangConfig() {
    return {
        display: 'C++11 GOC Turtle',
        code_file: 'foo.cc',
        compile: buildCompileCommand(),
        execute: buildExecuteCommand(),
        highlight: 'cpp',
        monaco: 'cpp',
        address_space_limit: true,
        process_limit: 1,
        compile_time_limit: 10000,
        time_limit_rate: 2,
        version: '/usr/bin/g++ --version',
    };
}

function getSystemModel() {
    return global.Hydro?.model?.system || SystemModel;
}

async function ensureGocLanguage(ctx, { dryrun = false, report = null } = {}) {
    const system = getSystemModel();
    const current = system.get('hydrooj.langs');
    if (typeof current !== 'string' || !current.trim()) {
        report?.({ message: 'hydrooj.langs is not loaded yet; skipped.' });
        return false;
    }
    const config = yaml.load(current) || {};
    if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.keys(config).some((key) => key === 'cc' || key.startsWith('cc.'))) {
        report?.({ message: 'hydrooj.langs does not look like a normal Hydro language config; skipped to avoid overwriting it.' });
        return false;
    }
    const nextLang = buildGocLangConfig();
    const oldLang = config[GOC_LANG];
    const changed = JSON.stringify(oldLang || null) !== JSON.stringify(nextLang);
    if (!changed) {
        report?.({ message: `${GOC_LANG} is already up to date.` });
        return false;
    }
    config[GOC_LANG] = nextLang;
    const next = yaml.dump(config, { lineWidth: -1, noRefs: true });
    report?.({ message: `${dryrun ? 'Would update' : 'Updating'} hydrooj.langs: ${GOC_LANG}` });
    if (!dryrun) {
        await system.set('hydrooj.langs', next);
        if (typeof ctx.emit === 'function') ctx.emit('system/setting', { hydrooj: { langs: next } });
    }
    return true;
}

function installGocLanguageScript(ctx) {
    ctx.addScript(
        'installGocLang',
        'Install or update the C++11 GOC Turtle language',
        Schema.object({
            dryrun: Schema.boolean().default(false),
        }),
        async ({ dryrun = false }, report) => {
            await ensureGocLanguage(ctx, { dryrun, report });
            report({ message: dryrun ? 'Dry run finished.' : 'GOC language installed. Restart Hydro/judger if the language list does not refresh immediately.' });
            return true;
        },
    );
}

function apply(ctx) {
    installRecordPreview(ctx);
    installGocLanguageScript(ctx);
    ensureGocLanguage(ctx).catch((err) => logger.error('Failed to install GOC language:', err));
    ctx.on('system/setting-loaded', () => {
        ensureGocLanguage(ctx).catch((err) => logger.error('Failed to install GOC language:', err));
    });
}

module.exports = { apply };
