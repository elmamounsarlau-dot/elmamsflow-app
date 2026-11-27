import 'server-only';
import ExcelJS from 'exceljs';
import { parseRows, tabTarget, type ParsedSheet, type ShipType } from './shipping-rates';

/** Read every tab of an uploaded .xlsx into rows of text (dates as 2026.11.23, formulas as their value). */
export async function readWorkbook(buf: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const text = (v: ExcelJS.CellValue): string => {
    if (v == null) return '';
    if (v instanceof Date) return `${v.getUTCFullYear()}.${v.getUTCMonth() + 1}.${v.getUTCDate()}`;
    if (typeof v === 'object') {
      if ('result' in v) return text((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
      if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
      if ('text' in v) return String((v as { text: unknown }).text);
      return '';
    }
    return String(v).trim();
  };
  return wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(ws.columnCount, 40); c++) cells.push(text(row.getCell(c).value));
      rows.push(cells);
    });
    return { name: ws.name, rows };
  });
}

export type TabResult = { name: string; line: string | null; type: ShipType | null; parsed: ParsedSheet };

/** Each tab with the line and product type its name points to, and what was read from it. */
export async function readRateWorkbook(buf: ArrayBuffer): Promise<TabResult[]> {
  return (await readWorkbook(buf)).map((t) => {
    const target = tabTarget(t.name);
    return { name: t.name, line: target?.line ?? null, type: target?.type ?? null, parsed: parseRows(t.rows) };
  });
}
