/** Check DOM query results before reading properties specific to an element class. */
export const elementOf = <T extends Element>(element: Element | null, constructor: { new (): T }): T => {
  if (!(element instanceof constructor)) throw new Error(`Expected ${constructor.name}`);

  return element;
};

export const elementOrNull = <T extends Element>(
  element: Element | null,
  constructor: { new (): T },
): T | null => (element === null ? null : elementOf(element, constructor));
