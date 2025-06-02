//types/Shipment.ts

export type ShipmentItem = {
    name: string;
    quantity: number;
  };
  
  export type Shipment = {
    si_number: string;         // 入力必須
    shop_id: string;           // 入力必須
    status?: string;
    etd?: string;              // 'YYYY-MM-DD'
    eta?: string;              // 'YYYY-MM-DD'
    delayed?: boolean;
    transport_type?: string;
    memo?: string;
    items?: ShipmentItem[];    // または any / object[] でもOK
    clearance_date?: string;   // 'YYYY-MM-DD'
    supplier_name?: string;
    arrival_date?: string;     // 'YYYY-MM-DD'
    is_archived?: boolean;
    invoice_url?: string;
    pl_url?: string;
    other_url?: string;
    si_url?: string;
  };