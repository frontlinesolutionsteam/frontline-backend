export interface CloverCustomer {
  id: string;
  firstName?: string;
  lastName?: string;
}

export interface CloverCustomerSearchResult {
  elements: CloverCustomer[];
}
