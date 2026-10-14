/** JSON data kept in memory may have optional fields before serialization omits undefined. */
export type JsonData = string | number | boolean | null | undefined | JsonDataArray | JsonDataFields;

export interface JsonDataArray extends ReadonlyArray<JsonData> {}

export interface JsonDataFields {
  [key: string]: JsonData;
}
