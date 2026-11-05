// Altimate xlsx writer -- a small, dependency-free .xlsx (Excel) exporter.
//
// Writes formatted spreadsheets that open in Excel, Google Sheets,
// LibreOffice and Apple Numbers: bold shaded header row, frozen header,
// column widths, currency cells and bold total rows. It is deliberately
// small so it can be reviewed in full. (Reading is xlsx-reader.js.)
//
// Shared module: keep copies in other Altimate apps identical to this one
// (same pattern as functions/_lib/firebase-auth.js).
//
// Usage (browser):
//   const { downloadXlsx } = await import("/lib/xlsx-writer.js");
//   downloadXlsx("order-list.xlsx", {
//       sheets: [{
//           name: "Order List",
//           columns: [
//               { header: "Part No.", width: 18 },
//               { header: "Qty", width: 8, type: "number" },
//               { header: "Unit Price", width: 12, type: "currency" }
//           ],
//           rows: [["100-001", 2, 12.5]],
//           footer: [["Total", null, 25]]   // optional, rendered bold
//       }]
//   });
//
// Cells are strings, numbers, Dates, null/undefined (empty), or objects
// { value, type, bold, currency } to override the column for one cell.
// Column/cell types: "text" (default), "number", "currency", "date"
// (shown as 2026-11-05) and "datetime" (shown as 2026-11-05 14:30).
// Currency cells show "$" unless the column or cell sets another symbol,
// e.g. { type: "currency", currency: "CA$" }. Columns may set wrap: true
// to wrap long text inside the cell.
// Strings are always written as text, never as formulas, so values
// beginning with "=" cannot execute in the spreadsheet.
//
// Dates are written as real spreadsheet dates (they sort, filter and
// calculate). "2026-11-05" and "2026-11-05 14:30[:00]" strings are taken
// exactly as written; Date objects and strings ending in Z or an offset
// are converted to the viewer's local time. Values that aren't valid dates
// (or are before 1900-03-01) are written as text so nothing is lost.
//
// Optional sheet extras:
//   title:  "Parts Order List" or ["Parts Order List", "Smith chair"]
//           -- lines above the header, each merged across every column;
//           the first is large and bold. The frozen header moves below.
//   merges: ["A5:C5", ...] -- extra merged ranges, in final sheet
//           coordinates (count title lines and the header row). Only the
//           top-left cell's value is shown. Overlapping merges throw.

const MAX_CELL_TEXT = 32767; // Excel's per-cell limit.

// ---- Styles -----------------------------------------------------------------
// Each distinct look (number format + font + fill + border + wrap) becomes one
// entry in styles.xml. The common ones are registered first, in a fixed
// order, so their indexes never change; others are added as they're used.

const DEFAULT_CURRENCY = "$";
const FONTS = [
    '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>'
];
const FONT = { normal: 0, bold: 1, title: 2 };
const FILLS = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE9ECEF"/><bgColor indexed="64"/></patternFill></fill>'
];
const BORDERS = [
    "<border><left/><right/><top/><bottom/><diagonal/></border>",
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border>'
];

function currencyFormat(symbol) {
    // Quoted literal, so any symbol ("CA$", "€", "USD ") is shown as-is.
    const text = String(symbol ?? DEFAULT_CURRENCY).replace(/["\\]/g, "").slice(0, 10);
    return `"${text}"#,##0.00`;
}

function createStyles() {
    const formats = new Map([
        [currencyFormat(DEFAULT_CURRENCY), 164],
        ["yyyy-mm-dd", 165],
        ["yyyy-mm-dd hh:mm", 166]
    ]);
    const xfs = [];
    const byKey = new Map();

    function formatId(code) {
        if (!code) return 0;
        if (!formats.has(code)) formats.set(code, 164 + formats.size);
        return formats.get(code);
    }

    function get({ format = null, font = FONT.normal, header = false, wrap = false } = {}) {
        const spec = {
            numFmtId: formatId(format),
            fontId: header ? FONT.bold : font,
            fillId: header ? 2 : 0,
            borderId: header ? 1 : 0,
            wrap
        };
        const key = `${spec.numFmtId}|${spec.fontId}|${spec.fillId}|${spec.borderId}|${wrap ? 1 : 0}`;
        if (!byKey.has(key)) {
            byKey.set(key, xfs.length);
            xfs.push(spec);
        }
        return byKey.get(key);
    }

    // Fixed indexes 0-9, registered in this order so they never move.
    const dollars = currencyFormat(DEFAULT_CURRENCY);
    get();                                                    // 0 normal
    get({ header: true });                                    // 1 header row
    get({ format: dollars });                                 // 2 currency
    get({ font: FONT.bold });                                 // 3 bold
    get({ format: dollars, font: FONT.bold });                // 4 bold currency
    get({ format: "yyyy-mm-dd" });                            // 5 date
    get({ format: "yyyy-mm-dd", font: FONT.bold });           // 6 bold date
    get({ format: "yyyy-mm-dd hh:mm" });                      // 7 datetime
    get({ format: "yyyy-mm-dd hh:mm", font: FONT.bold });     // 8 bold datetime
    get({ font: FONT.title });                                // 9 title

    function xml() {
        const numFmts = [...formats].map(([code, id]) =>
            `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`).join("");
        const cellXfs = xfs.map(x =>
            `<xf numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" ` +
            `borderId="${x.borderId}" xfId="0"` +
            (x.numFmtId ? ' applyNumberFormat="1"' : "") +
            (x.fontId ? ' applyFont="1"' : "") +
            (x.fillId ? ' applyFill="1"' : "") +
            (x.borderId ? ' applyBorder="1"' : "") +
            (x.wrap ? ' applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' : "/>")
        ).join("");
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            `<numFmts count="${formats.size}">${numFmts}</numFmts>` +
            `<fonts count="${FONTS.length}">${FONTS.join("")}</fonts>` +
            `<fills count="${FILLS.length}">${FILLS.join("")}</fills>` +
            `<borders count="${BORDERS.length}">${BORDERS.join("")}</borders>` +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            `<cellXfs count="${xfs.length}">${cellXfs}</cellXfs>` +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
            "</styleSheet>";
    }

    return { get, xml };
}

// ---- Dates ------------------------------------------------------------------

const MS_PER_DAY = 86400000;
// Spreadsheet day 0 is 1899-12-30 (this absorbs Excel's 1900 leap-year bug
// for every date from 1900-03-01 on, which is why earlier dates are text).
const EPOCH_UTC = Date.UTC(1899, 11, 30);
const MIN_SERIAL = 61; // 1900-03-01

function serialFromParts(year, month, day, hours = 0, minutes = 0, seconds = 0) {
    const utc = Date.UTC(year, month - 1, day, hours, minutes, seconds);
    const check = new Date(utc);
    // Reject impossible dates such as 2026-02-30 instead of rolling over.
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day) {
        return null;
    }
    return (utc - EPOCH_UTC) / MS_PER_DAY;
}

export function dateSerial(value) {
    let serial = null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        serial = serialFromParts(
            value.getFullYear(), value.getMonth() + 1, value.getDate(),
            value.getHours(), value.getMinutes(), value.getSeconds()
        );
    } else if (typeof value === "string") {
        const text = value.trim();
        const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(text);
        if (local) {
            const [, y, mo, d, h = "0", mi = "0", s = "0"] = local;
            if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
            serial = serialFromParts(+y, +mo, +d, +h, +mi, +s);
        } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
            return dateSerial(new Date(text.replace(" ", "T")));
        }
    }
    if (serial === null || serial < MIN_SERIAL) return null;
    // Round to the second to avoid floating-point noise such as 14:29:59.
    return Math.round(serial * 86400) / 86400;
}

// ---- Merged ranges ----------------------------------------------------------

function parseRef(ref) {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
    if (!match) return null;
    let col = 0;
    for (const char of match[1]) col = col * 26 + (char.charCodeAt(0) - 64);
    if (col > 16384 || Number(match[2]) > 1048576) return null;
    return { row: Number(match[2]), col };
}

function parseRange(range) {
    const parts = String(range || "").trim().toUpperCase().split(":");
    const a = parseRef(parts[0]);
    const b = parts.length === 2 ? parseRef(parts[1]) : null;
    if (!a || !b) throw new Error(`Invalid merge range "${range}".`);
    const box = {
        top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row),
        left: Math.min(a.col, b.col), right: Math.max(a.col, b.col)
    };
    if (box.top === box.bottom && box.left === box.right) {
        throw new Error(`Merge range "${range}" is a single cell.`);
    }
    box.ref = `${columnName(box.left - 1)}${box.top}:${columnName(box.right - 1)}${box.bottom}`;
    return box;
}

function checkMerges(boxes) {
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            if (a.left <= b.right && b.left <= a.right &&
                a.top <= b.bottom && b.top <= a.bottom) {
                throw new Error(`Merge ranges ${a.ref} and ${b.ref} overlap.`);
            }
        }
    }
}

// ---- XML helpers -----------------------------------------------------------

function xmlEscape(value) {
    return String(value)
        // Characters XML 1.0 does not allow at all.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function columnName(index) {
    let name = "";
    let n = index + 1;
    while (n > 0) {
        const remainder = (n - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function sheetName(name, index, used) {
    let base = String(name || `Sheet${index + 1}`)
        .replace(/[\[\]:*?\/\\]/g, " ")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, 31) || `Sheet${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
        const tail = ` (${suffix++})`;
        candidate = base.slice(0, 31 - tail.length) + tail;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

function cellXml(ref, cell, column, rowBold, styles) {
    const isObject = cell !== null && typeof cell === "object" && !(cell instanceof Date);
    const value = isObject ? cell.value : cell;
    if (value === null || value === undefined || value === "") return "";
    if (value instanceof Date && Number.isNaN(value.getTime())) return "";

    const type = (isObject && cell.type) ||
        (column && column.type) || (value instanceof Date ? "datetime" : "text");
    const bold = rowBold || (isObject && cell.bold === true);
    const font = bold ? FONT.bold : FONT.normal;
    const wrap = Boolean(column && column.wrap);
    const styleAttr = spec => {
        const index = styles.get({ ...spec, font, wrap });
        return index ? ` s="${index}"` : "";
    };

    if (type === "date" || type === "datetime") {
        const serial = dateSerial(value);
        if (serial !== null) {
            const format = type === "date" ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm";
            return `<c r="${ref}"${styleAttr({ format })}><v>${serial}</v></c>`;
        }
        // Not a usable date: fall through and keep it as text.
    }

    const number = typeof value === "number" ? value : Number(value);
    if ((type === "number" || type === "currency") && Number.isFinite(number) &&
        !(value instanceof Date) && String(value).trim() !== "") {
        const symbol = isObject && cell.currency !== undefined
            ? cell.currency
            : (column && column.currency !== undefined ? column.currency : DEFAULT_CURRENCY);
        const format = type === "currency" ? currencyFormat(symbol) : null;
        return `<c r="${ref}"${styleAttr({ format })}><v>${number}</v></c>`;
    }

    const text = (value instanceof Date ? value.toISOString() : String(value))
        .slice(0, MAX_CELL_TEXT);
    return `<c r="${ref}" t="inlineStr"${styleAttr({})}>` +
        `<is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function sheetXml(sheet, styles) {
    const columns = sheet.columns || [];
    const rows = sheet.rows || [];
    const footer = sheet.footer || [];
    const titles = (Array.isArray(sheet.title) ? sheet.title : [sheet.title])
        .filter(line => line !== undefined && line !== null && line !== "");
    const hasHeader = columns.some(column => column.header !== undefined);
    const headerRow = titles.length + 1;
    const freeze = hasHeader && sheet.freezeHeader !== false;
    const width = Math.max(
        columns.length,
        ...rows.map(row => (row || []).length),
        ...footer.map(row => (row || []).length),
        1
    );

    // Title lines span every column; then any caller-supplied merges.
    const merges = [];
    if (width > 1) {
        titles.forEach((_, index) => {
            merges.push(parseRange(`A${index + 1}:${columnName(width - 1)}${index + 1}`));
        });
    }
    (sheet.merges || []).forEach(range => merges.push(parseRange(range)));
    checkMerges(merges);

    const out = [];
    out.push(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    );

    out.push('<sheetViews><sheetView workbookViewId="0">');
    if (freeze) {
        out.push(
            `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" ` +
            'activePane="bottomLeft" state="frozen"/>'
        );
    }
    out.push("</sheetView></sheetViews>");

    if (columns.some(column => column.width)) {
        out.push("<cols>");
        columns.forEach((column, index) => {
            const columnWidth = Number(column.width) || 10;
            out.push(`<col min="${index + 1}" max="${index + 1}" width="${columnWidth}" customWidth="1"/>`);
        });
        out.push("</cols>");
    }

    out.push("<sheetData>");
    let rowNumber = 0;

    titles.forEach((line, index) => {
        rowNumber += 1;
        const style = index === 0 ? styles.get({ font: FONT.title }) : 0;
        out.push(
            `<row r="${rowNumber}"${index === 0 ? ' ht="20" customHeight="1"' : ""}>` +
            `<c r="A${rowNumber}" t="inlineStr"${style ? ` s="${style}"` : ""}>` +
            `<is><t xml:space="preserve">${xmlEscape(String(line).slice(0, MAX_CELL_TEXT))}</t></is></c>` +
            "</row>"
        );
    });

    if (hasHeader) {
        rowNumber += 1;
        out.push(`<row r="${rowNumber}">`);
        columns.forEach((column, index) => {
            out.push(
                `<c r="${columnName(index)}${rowNumber}" t="inlineStr" s="${styles.get({ header: true })}">` +
                `<is><t xml:space="preserve">${xmlEscape(column.header ?? "")}</t></is></c>`
            );
        });
        out.push("</row>");
    }

    const writeRow = (row, bold) => {
        rowNumber += 1;
        out.push(`<row r="${rowNumber}">`);
        (row || []).forEach((cell, index) => {
            out.push(cellXml(`${columnName(index)}${rowNumber}`, cell, columns[index], bold, styles));
        });
        out.push("</row>");
    };
    rows.forEach(row => writeRow(row, false));
    footer.forEach(row => writeRow(row, true));

    out.push("</sheetData>");
    if (merges.length) {
        out.push(`<mergeCells count="${merges.length}">`);
        merges.forEach(box => out.push(`<mergeCell ref="${box.ref}"/>`));
        out.push("</mergeCells>");
    }
    out.push("</worksheet>");
    return out.join("");
}

function workbookFiles(workbook) {
    const sheets = workbook && Array.isArray(workbook.sheets) ? workbook.sheets : [];
    if (!sheets.length) throw new Error("A workbook needs at least one sheet.");

    const used = new Set();
    const names = sheets.map((sheet, index) => sheetName(sheet.name, index, used));

    const files = [];
    files.push(["[Content_Types].xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        ).join("") +
        "</Types>"]);
    files.push(["_rels/.rels",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>"]);
    files.push(["xl/workbook.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((name, index) =>
            `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
        ).join("") +
        "</sheets></workbook>"]);
    files.push(["xl/_rels/workbook.xml.rels",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, index) =>
            `<Relationship Id="rId${index + 1}" ` +
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
            `Target="worksheets/sheet${index + 1}.xml"/>`
        ).join("") +
        `<Relationship Id="rId${sheets.length + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>"]);
    // Sheets first: they register the styles they use.
    const styles = createStyles();
    const sheetFiles = sheets.map((sheet, index) =>
        [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet, styles)]);
    files.push(["xl/styles.xml", styles.xml()]);
    files.push(...sheetFiles);
    return files;
}

// ---- ZIP (store only, no compression) --------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
    const encoder = new TextEncoder();
    const DOS_TIME = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, fixed so output is reproducible.
    const UTF8_FLAG = 0x0800;

    const entries = files.map(([name, content]) => {
        const nameBytes = encoder.encode(name);
        const data = typeof content === "string" ? encoder.encode(content) : content;
        return { nameBytes, data, crc: crc32(data) };
    });

    const localSize = entries.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
    const centralSize = entries.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
    const buffer = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(buffer.buffer);
    let offset = 0;

    const u16 = value => { view.setUint16(offset, value, true); offset += 2; };
    const u32 = value => { view.setUint32(offset, value, true); offset += 4; };
    const bytes = value => { buffer.set(value, offset); offset += value.length; };

    entries.forEach(entry => {
        entry.offset = offset;
        u32(0x04034B50); u16(20); u16(UTF8_FLAG); u16(0); u16(DOS_TIME); u16(DOS_DATE);
        u32(entry.crc); u32(entry.data.length); u32(entry.data.length);
        u16(entry.nameBytes.length); u16(0);
        bytes(entry.nameBytes);
        bytes(entry.data);
    });

    const centralOffset = offset;
    entries.forEach(entry => {
        u32(0x02014B50); u16(20); u16(20); u16(UTF8_FLAG); u16(0); u16(DOS_TIME); u16(DOS_DATE);
        u32(entry.crc); u32(entry.data.length); u32(entry.data.length);
        u16(entry.nameBytes.length); u16(0); u16(0); u16(0); u16(0); u32(0);
        u32(entry.offset);
        bytes(entry.nameBytes);
    });

    u32(0x06054B50); u16(0); u16(0); u16(entries.length); u16(entries.length);
    u32(centralSize); u32(centralOffset); u16(0);
    return buffer;
}

// ---- Public API -------------------------------------------------------------

export const XLSX_MIME_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Returns the .xlsx file as a Uint8Array.
export function buildXlsx(workbook) {
    return zip(workbookFiles(workbook));
}

// Browser only: builds the workbook and starts a download.
export function downloadXlsx(filename, workbook) {
    const blob = new Blob([buildXlsx(workbook)], { type: XLSX_MIME_TYPE });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
