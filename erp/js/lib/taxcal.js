// 年度／每月 會計申報與重要事項工作表（台灣）。
// 期限為法定常態日期，遇週末順延至週一；另依設定產生「開始準備／目標完成」的內部期限（自行申報，法定期限前完成）。
// 實際以財政部、勞保局、健保署當年度公告為準（國定假日請自行留意）。

const pad = (n) => String(n).padStart(2, '0');

function lastDay(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 週六、週日順延至週一（國定假日請自行留意）
export function shiftWeekend(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const wd = d.getUTCDay();
  if (wd === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (wd === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 內部期限遇週末提前到週五
function weekdayBack(ymd) {
  const wd = new Date(ymd + 'T00:00:00Z').getUTCDay();
  if (wd === 6) return addDays(ymd, -1);
  if (wd === 0) return addDays(ymd, -2);
  return ymd;
}

/**
 * 內部目標：期限當月「開始準備日」與「目標完成日」。
 * 法定期限在目標日之前（例如 10 日的扣繳）者，目標改為期限前 buffer 天。
 */
export function internalTargets(dueYmd, { prepDay = 10, targetDay = 12, buffer = 3 } = {}) {
  const ym = dueYmd.slice(0, 7);
  let target = `${ym}-${pad(targetDay)}`;
  if (target > addDays(dueYmd, -buffer)) target = addDays(dueYmd, -buffer);
  target = weekdayBack(target);
  let prep = `${ym}-${pad(Math.min(prepDay, targetDay))}`;
  if (prep > target) prep = addDays(target, -2);
  return { prep: weekdayBack(prep), target };
}

/**
 * profile: { orgType: 'company'|'sole', vatMode: 'general'|'small'|'none', hasEmployees, ownsProperty, hasVehicle, paysRentToIndividual, prepDay, targetDay }
 */
export function buildCalendar(year, profile = {}) {
  const p = { orgType: 'sole', vatMode: 'general', hasEmployees: true, ownsProperty: false, hasVehicle: false, paysRentToIndividual: true, prepDay: 10, targetDay: 12, ...profile };
  const roc = year - 1911;
  const items = [];
  const add = (date, title, detail, tags, cond = true, extra = {}) => {
    if (!cond) return;
    const due = shiftWeekend(date);
    const it = { id: `${date}|${title}`, date, due, title, detail, tags, filing: true, ...extra };
    if (it.filing) Object.assign(it, internalTargets(due, { prepDay: p.prepDay, targetDay: p.targetDay }));
    else Object.assign(it, { prep: null, target: due });
    items.push(it);
  };
  const withholding = p.hasEmployees || p.paysRentToIndividual;

  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${pad(m)}`;
    const prevM = m === 1 ? 12 : m - 1;
    add(`${ym}-05`, `${prevM} 月帳務結帳`, '完成「每月結帳前檢查表」：POS、金流撥款、憑證、存摺對帳、盤點、折舊，產出試算表與損益表。申報前先完成結帳，數字才會正確。', ['內部作業'], true, { kind: 'monthly', filing: false });
    add(`${ym}-10`, `繳納 ${prevM} 月扣繳稅款`, '上月給付薪資、租金（房東為個人）、執行業務報酬等已扣繳之所得稅，於 10 日前繳納。', ['扣繳'], withholding, { kind: 'monthly' });
    add(`${ym}-${pad(lastDay(year, m))}`, `繳納 ${prevM} 月勞保、就保、職保、健保、勞退`, '依勞保局、健保署寄發之繳款單，於當月底前繳納上月份保費；新進、離職人員記得加退保。', ['勞健保'], p.hasEmployees, { kind: 'monthly' });
    add(`${ym}-${pad(lastDay(year, m))}`, `繳納 ${prevM} 月二代健保補充保費`, '給付個人房東租金單次達 2 萬元、兼職人員薪資超過基本工資等，扣取 2.11% 補充保費，於次月底前繳納。', ['勞健保'], withholding, { kind: 'monthly' });
    if (m % 2 === 1) {
      const a = m === 1 ? 11 : m - 2;
      const b = m === 1 ? 12 : m - 1;
      const periodKey = m === 1 ? `${year - 1}-11` : `${year}-${pad(m - 2)}`;
      add(`${ym}-15`, `營業稅申報（${a}–${b} 月）`, `一般稅額營業人每兩個月為一期，${m} 月 15 日前申報 401 表並繳納。先用「營業稅申報（401）」工作表核對銷項、進項與留抵稅額。`, ['營業稅'], p.vatMode === 'general', { kind: 'bimonthly', vatPeriod: periodKey });
    }
    if ([1, 4, 7, 10].includes(m)) {
      add(`${ym}-${pad(lastDay(year, m))}`, '小規模營業人營業稅繳款書', '國稅局每季核定並寄發繳款書（查定課徵 1%），依繳款書所載期限繳納；進項憑證可按季申報扣減。', ['營業稅'], p.vatMode === 'small', { kind: 'quarterly' });
    }
  }
  add(`${year}-01-31`, `扣繳憑單申報（${roc - 1} 年度）`, '申報上年度各類所得扣繳暨免扣繳憑單（薪資、租金、執行業務等），1 月底前完成。', ['扣繳'], withholding);
  add(`${year}-02-10`, '填發扣繳憑單給所得人', '2 月 10 日前將扣繳憑單交付員工、房東等所得人。', ['扣繳'], withholding);
  add(`${year}-01-31`, '二代健保補充保費扣費明細申報', '扣費義務人彙報上年度扣取補充保費明細（兼職薪資、租金、執行業務等達起扣點者）。', ['勞健保'], withholding);
  add(`${year}-01-01`, '最低工資調整生效，確認薪資與投保級距', '檢查時薪、月薪是否符合新年度最低工資，並調整勞健保投保薪資。', ['人事'], p.hasEmployees, { filing: false });
  add(`${year}-${year % 4 === 0 ? '02-29' : '02-28'}`, `${roc - 1} 年度決算`, '會計年度終了後二個月內辦理決算、編製財務報表，並完成年底結帳分錄。', ['年度結算'], true, { filing: false });
  add(`${year}-05-31`, `營利事業所得稅結算申報（${roc - 1} 年度）`, p.orgType === 'company' ? '5/1–5/31 辦理結算申報並繳納應納稅額。' : '獨資、合夥組織（商號）仍須辦理結算申報，但免計算及繳納營所稅，盈餘併入負責人綜合所得稅。', ['所得稅'], p.vatMode !== 'small', { start: `${year}-05-01` });
  add(`${year}-05-31`, `負責人綜合所得稅結算申報（${roc - 1} 年度）`, '5/1–5/31 申報；商號（獨資／合夥）之營利所得併入。', ['所得稅'], true, { start: `${year}-05-01` });
  add(`${year}-05-31`, '房屋稅繳納', '5 月開徵，自有房屋者繳納。', ['地方稅'], p.ownsProperty, { start: `${year}-05-01` });
  add(`${year}-04-30`, '使用牌照稅繳納', '4 月開徵，營業用車輛。', ['地方稅'], p.hasVehicle, { start: `${year}-04-01` });
  add(`${year}-09-30`, `營所稅暫繳申報（${roc} 年度）`, '9/1–9/30 辦理暫繳（公司組織；依規定免辦者除外）。', ['所得稅'], p.orgType === 'company' && p.vatMode !== 'small', { start: `${year}-09-01` });
  add(`${year}-11-30`, '地價稅繳納', '11 月開徵，自有土地者繳納。', ['地方稅'], p.ownsProperty, { start: `${year}-11-01` });
  add(`${year}-12-31`, '年底盤點與關帳準備', '咖啡豆、乳品、包材、零售商品全面盤點；固定資產實地盤點；確認應付／預付費用與寄杯預收餘額。', ['年度結算'], true, { filing: false });
  add(`${year}-12-31`, '憑證與帳簿保存檢查', '會計憑證至少保存 5 年、帳簿及財務報表至少保存 10 年（年度決算完成後起算）；確認加密備份。', ['內部作業'], true, { filing: false });
  return items.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}
