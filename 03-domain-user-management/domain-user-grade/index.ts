import {
  ContestModel, Context, db, DomainModel, Handler, PERM, SettingModel, Schema, UserModel,
} from 'hydrooj';

export const name = 'domain-user-grade';

const DEFAULT_GRADES = [
  '\u5c0f\u5b66\u4e00\u5e74\u7ea7',
  '\u5c0f\u5b66\u4e8c\u5e74\u7ea7',
  '\u5c0f\u5b66\u4e09\u5e74\u7ea7',
  '\u5c0f\u5b66\u56db\u5e74\u7ea7',
  '\u5c0f\u5b66\u4e94\u5e74\u7ea7',
  '\u5c0f\u5b66\u516d\u5e74\u7ea7',
  '\u521d\u4e00',
  '\u521d\u4e8c',
  '\u521d\u4e09',
  '\u9ad8\u4e00',
  '\u9ad8\u4e8c',
  '\u9ad8\u4e09',
];

const EMPTY_GRADE_LABEL = '\u672a\u586b\u5199';

export const Config = Schema.object({
  fieldKey: Schema.string().default('grade').description('Domain user field key used to store grade'),
  fieldName: Schema.string().default('\u5e74\u7ea7').description('Label shown in domain user settings'),
  fieldDescription: Schema.string()
    .default('\u8bf7\u9009\u62e9\u5f53\u524d\u6240\u5728\u5e74\u7ea7\u3002')
    .description('Help text shown below the field'),
  grades: Schema.array(Schema.string()).default(DEFAULT_GRADES).description('Allowed grade options'),
}).description('Domain user grade profile field');

type PluginConfig = ReturnType<typeof Config>;
type AnyDoc = Record<string, any>;
type ScoreboardNode = { type: string; value: string; raw?: any; score?: number; style?: string; hover?: string };
type ScoreboardRow = ScoreboardNode[] & { raw?: any };

let pluginConfig: PluginConfig;
const collDomainUser = db.collection('domain.user' as any);

function cleanGrade(value: any) {
  return String(value || '').trim();
}

function gradeOptions(config: PluginConfig) {
  const options: Record<string, string> = { '': EMPTY_GRADE_LABEL };
  for (const grade of config.grades || []) {
    const text = cleanGrade(grade);
    if (text) options[text] = text;
  }
  return options;
}

function allowedGrades(config = pluginConfig) {
  return new Set(Object.keys(gradeOptions(config)));
}

function invalidGradeQuery(domainId: string) {
  const allowed = [...allowedGrades()].filter(Boolean);
  return {
    domainId,
    [pluginConfig.fieldKey]: { $exists: true, $nin: allowed, $ne: '' },
  };
}

function csvCell(value: any) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: any[][]) {
  return `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`;
}

function toScoreboardCsv(rows: ScoreboardRow[]) {
  return toCsv(rows.map((row) => row.map((column) => column.value)));
}

async function loadDomainUsers(domainId: string) {
  const dudocs = await DomainModel.getMultiUserInDomain(domainId, { uid: { $gt: 1 } })
    .sort({ uid: 1 })
    .toArray();
  const uids = dudocs.map((doc: AnyDoc) => doc.uid);
  const udict = uids.length ? await UserModel.getListForRender(domainId, uids, ['displayName']) : {};
  return { dudocs, udict };
}

function gradeStats(dudocs: AnyDoc[]) {
  const allowed = allowedGrades();
  const rows = Object.values(gradeOptions(pluginConfig)).map((label) => ({ grade: label, count: 0 }));
  const index = new Map(rows.map((row) => [row.grade, row]));
  const invalid: AnyDoc[] = [];
  let filled = 0;
  for (const doc of dudocs) {
    const grade = cleanGrade(doc[pluginConfig.fieldKey]);
    if (!grade) {
      index.get(EMPTY_GRADE_LABEL)!.count++;
    } else if (allowed.has(grade)) {
      filled++;
      index.get(grade)!.count++;
    } else {
      invalid.push(doc);
    }
  }
  return { rows, filled, invalid };
}

async function loadGrades(domainId: string, uids: number[]): Promise<Map<number, string>> {
  if (!uids.length) return new Map<number, string>();
  const docs = await collDomainUser.find({
    domainId,
    uid: { $in: [...new Set(uids)] },
  }).toArray();
  return new Map<number, string>(docs.map((doc: AnyDoc) => [Number(doc.uid), cleanGrade(doc[pluginConfig.fieldKey])]));
}

async function appendGradeColumn(domainId: string, rows: ScoreboardRow[]) {
  if (!rows.length) return rows;
  const header = rows[0];
  const userColumn = header.findIndex((column) => column.type === 'user');
  if (userColumn < 0) return rows;
  const gradeColumn = userColumn + 1;
  const uids = rows
    .slice(1)
    .map((row) => Number(row[userColumn]?.raw))
    .filter((uid) => Number.isSafeInteger(uid) && uid > 1);
  const grades = await loadGrades(domainId, uids);
  const nextRows = rows.map((row, index) => {
    const next = row.slice() as ScoreboardRow;
    next.raw = row.raw;
    if (!index) {
      next.splice(gradeColumn, 0, { type: 'string', value: pluginConfig.fieldName || '年级' });
      return next;
    }
    const uid = Number(row[userColumn]?.raw);
    next.splice(gradeColumn, 0, {
      type: 'string',
      value: Number.isSafeInteger(uid) ? grades.get(uid) || '' : '',
    });
    return next;
  });
  return nextRows;
}

async function getExportRows(handler: any, tdoc: AnyDoc) {
  const [, rows] = await ContestModel.getScoreboard.call(handler, tdoc.domainId, tdoc._id, {
    isExport: true,
    lockAt: handler.tdoc.lockAt,
    showDisplayName: handler.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
  });
  return await appendGradeColumn(tdoc.domainId, rows as ScoreboardRow[]);
}

function patchScoreboardViewDisplays(scoreboard: any) {
  const htmlView = scoreboard.getView('html');
  const csvView = scoreboard.getView('csv');

  if (htmlView) {
    htmlView.display = async function displayGradeHtml({ tdoc }: any) {
      await this.limitRate('scoreboard_download', 60, 3);
      const rows = await getExportRows(this, tdoc);
      this.binary(await this.renderHTML('contest_scoreboard_download_html.html', { rows, tdoc }), `${this.tdoc.title}.html`);
    };
  }

  if (csvView) {
    csvView.display = async function displayGradeCsv({ tdoc }: any) {
      await this.limitRate('scoreboard_download', 60, 3);
      const rows = await getExportRows(this, tdoc);
      this.binary(toScoreboardCsv(rows), `${this.tdoc.title}.csv`);
    };
  }
}

function patchScoreboardExports(ctx: Context) {
  ctx.inject(['scoreboard'], (c: any) => {
    const scoreboard = c.scoreboard;
    patchScoreboardViewDisplays(scoreboard);
    if (scoreboard.__domainUserGradeExportPatched) return;
    scoreboard.__domainUserGradeExportPatched = true;
    const addView = scoreboard.addView.bind(scoreboard);
    scoreboard.addView = (...args: any[]) => {
      const result = addView(...args);
      patchScoreboardViewDisplays(scoreboard);
      return result;
    };
  });
}

class DomainUserGradeHandler extends Handler {
  async get({ domainId }: any) {
    const { dudocs, udict } = await loadDomainUsers(domainId);
    const stats = gradeStats(dudocs);
    this.response.template = 'domain_user_grade.html';
    this.response.body = {
      page_name: 'domain_user_grade',
      domain: this.domain,
      fieldKey: pluginConfig.fieldKey,
      total: dudocs.length,
      filled: stats.filled,
      empty: stats.rows.find((row) => row.grade === EMPTY_GRADE_LABEL)?.count || 0,
      invalidRows: stats.invalid.map((doc) => ({
        grade: cleanGrade(doc[pluginConfig.fieldKey]),
        user: udict[doc.uid] || { _id: doc.uid, uname: `UID ${doc.uid}` },
      })),
      stats: stats.rows,
      exportUrl: this.url('domain_user_grade_export'),
    };
  }

  async post({ domainId }: any) {
    const query = invalidGradeQuery(domainId);
    await collDomainUser.updateMany(query, { $set: { [pluginConfig.fieldKey]: '' } });
    this.back();
  }
}

class DomainUserGradeExportHandler extends Handler {
  async get({ domainId }: any) {
    const { dudocs, udict } = await loadDomainUsers(domainId);
    const rows = [
      ['uid', 'username', 'displayName', 'role', 'joined', pluginConfig.fieldKey],
      ...dudocs.map((doc: AnyDoc) => {
        const udoc = udict[doc.uid] || {};
        return [
          doc.uid,
          udoc.uname || '',
          doc.displayName || udoc.displayName || '',
          doc.role || 'default',
          doc.join ? 'true' : 'false',
          cleanGrade(doc[pluginConfig.fieldKey]),
        ];
      }),
    ];
    this.binary(toCsv(rows), `${domainId}-user-grade.csv`);
  }
}

export async function apply(ctx: Context, config: PluginConfig) {
  pluginConfig = config;
  const range = gradeOptions(config);
  const allowed = new Set(Object.keys(range));
  SettingModel.DomainUserSetting(
    SettingModel.Setting(
      'setting_info',
      config.fieldKey,
      '',
      range,
      config.fieldName,
      config.fieldDescription,
      SettingModel.FLAG_PRIVATE,
      (value: any) => allowed.has(cleanGrade(value)),
    ),
  );

  ctx.Route('domain_user_grade', '/domain/user-grade', DomainUserGradeHandler, PERM.PERM_EDIT_DOMAIN);
  ctx.Route('domain_user_grade_export', '/domain/user-grade/export', DomainUserGradeExportHandler, PERM.PERM_EDIT_DOMAIN);
  ctx.injectUI('DomainManage', 'domain_user_grade', { family: 'Access Control', icon: 'user' }, PERM.PERM_EDIT_DOMAIN);
  patchScoreboardExports(ctx);
  ctx.i18n.load('zh', {
    domain_user_grade: '\u5e74\u7ea7\u7ba1\u7406',
  });
  ctx.i18n.load('en', {
    domain_user_grade: 'User Grade',
  });
}
