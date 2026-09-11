export interface PayerDto {
  email: string;
}

export interface ProcesarPagoDto {
  transaction_amount: number;
  token: string;
  installments?: number;
  payment_method_id: string;
  payer: PayerDto;
}
