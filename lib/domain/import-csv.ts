export type ParsedCsvRow = {
  line: number;
  values: string[];
  fields: Record<string, string>;
};

export type ParsedCsv = {
  header: string[];
  rows: ParsedCsvRow[];
};

export class CsvParseError extends Error {
  readonly line: number;

  constructor(code: string, line: number) {
    super(code);
    this.name = "CsvParseError";
    this.line = line;
  }
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const records: { line: number; values: string[] }[] = [];
  let values: string[] = [];
  let field = "";
  let line = 1;
  let rowStartLine = 1;
  let inQuotes = false;
  let afterQuote = false;

  const finishField = (): void => {
    values.push(field);
    field = "";
    afterQuote = false;
  };
  const finishRow = (): void => {
    finishField();
    records.push({ line: rowStartLine, values });
    values = [];
    rowStartLine = line + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (character === "\n") line += 1;
        field += character;
      }
      continue;
    }

    if (afterQuote && character !== "," && character !== "\n") {
      throw new CsvParseError("unexpected_character_after_quote", line);
    }
    if (character === '"' && field.length === 0 && !afterQuote) {
      inQuotes = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
      line += 1;
    } else {
      if (character === '"') throw new CsvParseError("unexpected_quote", line);
      field += character;
    }
  }

  if (inQuotes) throw new CsvParseError("unterminated_quote", rowStartLine);
  if (field.length > 0 || values.length > 0 || afterQuote) finishRow();
  if (records.length === 0) return { header: [], rows: [] };

  const [headerRecord, ...dataRecords] = records;
  return {
    header: headerRecord.values,
    rows: dataRecords.map(({ line: rowLine, values: rowValues }) => ({
      line: rowLine,
      values: rowValues,
      fields: Object.fromEntries(headerRecord.values.map((name, index) => [name, rowValues[index] ?? ""])),
    })),
  };
}
