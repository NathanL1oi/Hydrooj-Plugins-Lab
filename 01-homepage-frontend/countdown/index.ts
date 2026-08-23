import { HomeHandler } from 'hydrooj/src/handler/home'
import { moment } from 'hydrooj'

async function getCountdown(payload) {
    const content = [];
    const dateToday = moment().startOf('day');
    const dates = Array.isArray(payload.dates) ? payload.dates : [];
    const maxDates = Number(payload.max_dates) || dates.length;

    dates.forEach(function (val) {
        if (content.length < maxDates) {
            const targetDate = moment(val.date).startOf('day');
            if (targetDate.isValid() && targetDate.isSameOrAfter(dateToday)) {
                const diffTime = targetDate.diff(dateToday, 'days');
                content.push({
                    name: val.name,
                    diff: diffTime
                });
            }
        }
    });
    payload.dates = content;

    // 添加公历日期信息
    const month = dateToday.month() + 1; // 月份 (0-11 → 1-12)
    const day = dateToday.date();
    const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const weekDay = weekDays[dateToday.day()];

    // 中文月份名称
    const chineseMonths = {
        1: '一月大', 2: '二月平', 3: '三月大', 4: '四月小', 5: '五月大', 6: '六月小',
        7: '七月大', 8: '八月大', 9: '九月小', 10: '十月大', 11: '十一月小', 12: '十二月大'
    };

    // 处理闰年
    if (dateToday.isLeapYear()) {
        chineseMonths[2] = '二月闰';
    }

    payload.calendar = {
        month: chineseMonths[month],
        day: day.toString().padStart(2, '0'),
        week: weekDay
    };

    return payload;
}

HomeHandler.prototype.getCountdown = async (domainId, payload) => {
    return await getCountdown(payload);
}
