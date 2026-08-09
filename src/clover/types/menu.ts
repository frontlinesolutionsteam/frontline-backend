export interface CloverElements<T> {
  elements: T[];
}

export interface CloverCategory {
  id: string;
  name: string;
  sortOrder?: number;
}

export interface CloverModifier {
  id: string;
  name: string;
  price?: number;
}

export interface CloverModifierGroup {
  id: string;
  name: string;
  minRequired?: number;
  maxAllowed?: number;
  modifiers?: CloverElements<CloverModifier>;
}

// Distinct from `available` -- an item can be quantity-tracked (autoManage)
// or just manually toggled on/off. quantity/stockAlertThreshold only appear
// when the item is expanded with `itemStock` and the merchant tracks stock
// for it at all; most items have no stock object.
export interface CloverItemStock {
  quantity?: number;
  stockAlertThreshold?: number;
}

export interface CloverItem {
  id: string;
  name: string;
  price?: number;
  hidden?: boolean;
  available?: boolean;
  modifiedTime?: number; // ms since epoch
  categories?: CloverElements<CloverCategory>;
  modifierGroups?: CloverElements<CloverModifierGroup>;
  itemStock?: CloverItemStock;
}

export interface CloverPage<T> {
  elements: T[];
  href?: string;
}
