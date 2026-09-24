// Building an Intl formatter costs far more than using one, and every frame formats a time for
// each visible row and message, so each style is built once.
const formatter = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options);
const clock = formatter({ hour: "numeric", minute: "2-digit" });
const weekday = formatter({ weekday: "short" });
const longWeekday = formatter({ weekday: "long" });
const monthDay = formatter({ month: "short", day: "numeric" });
const weekdayMonthDay = formatter({ weekday: "short", month: "short", day: "numeric" });
const monthDayYear = formatter({ month: "short", day: "numeric", year: "numeric" });

export const formatClock = (ms: number) => clock.format(ms);
export const formatWeekday = (ms: number) => weekday.format(ms);
export const formatLongWeekday = (ms: number) => longWeekday.format(ms);
export const formatMonthDay = (ms: number) => monthDay.format(ms);
export const formatWeekdayMonthDay = (ms: number) => weekdayMonthDay.format(ms);
export const formatMonthDayYear = (ms: number) => monthDayYear.format(ms);
