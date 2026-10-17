/*
 * Minimal RFC 4180 CSV reader and writer. Pure: no I/O.
 */

/**
 * Parse CSV text into rows of fields. Strips a leading BOM; understands quoted fields, `""`
 * escapes, commas and newlines inside quotes, and CRLF or LF line ends. Fully blank trailing
 * lines are dropped (a blank line in the middle stays as `['']`).
 * Throws `RangeError` on an unterminated quote.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < src.length) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
      } else {
        field += ch
      }
      i += 1
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === ',') {
      endField()
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1
      endRow()
    } else if (ch === '\n') {
      endRow()
    } else {
      field += ch
    }
    i += 1
  }
  if (inQuotes) throw new RangeError('The file has a quote that is never closed.')
  if (field !== '' || row.length > 0) endRow()

  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') rows.pop()
    else break
  }
  return rows
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field
}

/** Serialize rows to CSV (CRLF line ends). Fields with a comma, quote or newline are quoted. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(quote).join(',') + '\r\n').join('')
}
