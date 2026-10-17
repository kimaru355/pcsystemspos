import { describe, expect, it } from 'vitest'
import { parseCsv, toCsv } from '@/domain/csv'

describe('parseCsv', () => {
  it('parses quoted fields, escaped quotes, commas and CRLF, and drops blank trailing lines', () => {
    expect(parseCsv('a,"b,c","d ""q"""\r\n1,2,3\r\n\r\n')).toEqual([
      ['a', 'b,c', 'd "q"'],
      ['1', '2', '3'],
    ])
  })

  it('handles LF line endings and a missing final newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('strips a leading BOM', () => {
    expect(parseCsv('﻿name,price\nx,1\n')).toEqual([
      ['name', 'price'],
      ['x', '1'],
    ])
  })

  it('keeps a newline inside quotes', () => {
    expect(parseCsv('a,"line1\nline2"\nz,y')).toEqual([
      ['a', 'line1\nline2'],
      ['z', 'y'],
    ])
  })

  it('keeps empty fields and a blank line in the middle as a single empty field', () => {
    expect(parseCsv('a,,c\n\nd,e,')).toEqual([['a', '', 'c'], [''], ['d', 'e', '']])
  })

  it('returns no rows for empty text', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n\n')).toEqual([])
  })

  it('throws RangeError on an unterminated quote', () => {
    expect(() => parseCsv('a,"b\nc')).toThrow(RangeError)
  })
})

describe('toCsv', () => {
  it('quotes fields that contain a comma, quote or newline', () => {
    expect(toCsv([['a', 'b,c', 'd"e', 'f\ng']])).toBe('a,"b,c","d""e","f\ng"\r\n')
  })

  it('round-trips rows with commas, quotes and newlines', () => {
    const rows = [
      ['name', 'note'],
      ['Nail, 3"', 'line1\nline2'],
      ['', 'plain'],
    ]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
})
