/** A made-up bank workbook (as a real .xlsx File) so someone can try the site without a file of their own. */
import { demoTables } from "../excel/demo";
import { buildXlsx } from "./xlsx-write";

export async function sampleFile(): Promise<File> {
  const blob = await buildXlsx(demoTables(3000));
  return new File([blob], "sample-bank-data.xlsx", { type: blob.type });
}
