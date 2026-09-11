import { IsEnum, IsISO8601, IsOptional } from 'class-validator';
import { estadoReservaEnum } from 'src/database/schema';

export class UpdateReservaStateDto {
  @IsEnum(estadoReservaEnum.enumValues)
  estado!: (typeof estadoReservaEnum.enumValues)[number];

  @IsOptional()
  fecha_fin?: string;
}
