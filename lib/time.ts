// Korea Standard Time formatting helpers (Asia/Seoul, no DST).

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** YYYY-MM-DD in KST. */
export function kstDate(d: Date | string = new Date()): string {
  return dateFmt.format(typeof d === 'string' ? new Date(d) : d)
}

/** YYYY-MM-DD HH:mm:ss KST */
export function kstDateTime(d: Date | string | null | undefined): string {
  if (!d) return '-'
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return '-'
  return `${dateFmt.format(date)} ${timeFmt.format(date)} KST`
}
