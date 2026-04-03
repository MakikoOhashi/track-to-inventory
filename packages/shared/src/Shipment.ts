export type ShipmentItem = {
  name: string;
  quantity: number;
  variant_id?: string;
};

export type Shipment = {
  si_number: string;
  shop_id: string;
  status?: string;
  etd?: string;
  eta?: string;
  delayed?: boolean;
  transport_type?: string;
  memo?: string;
  items?: ShipmentItem[];
  clearance_date?: string;
  supplier_name?: string;
  arrival_date?: string;
  is_archived?: boolean;
  invoice_url?: string;
  pl_url?: string;
  other_url?: string;
  si_url?: string;
};
