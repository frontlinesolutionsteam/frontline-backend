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

export interface CloverItem {
  id: string;
  name: string;
  price?: number;
  hidden?: boolean;
  available?: boolean;
  modifiedTime?: number; // ms since epoch
  categories?: CloverElements<CloverCategory>;
  modifierGroups?: CloverElements<CloverModifierGroup>;
}

export interface CloverPage<T> {
  elements: T[];
  href?: string;
}
