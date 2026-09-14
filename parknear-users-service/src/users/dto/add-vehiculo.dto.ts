export class AddVehiculoDto {
  placa!: string;
  color!: string;
  marca!: string;
}

export class UpdateVehiculoDto {
  color?: string;
  marca?: string;
}