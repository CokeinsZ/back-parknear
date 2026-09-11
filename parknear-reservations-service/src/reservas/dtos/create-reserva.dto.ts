import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReservaDto {
  @IsUUID()
  id_conductor!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  id_zona!: number;

  @IsString()
  @MaxLength(10)
  id_vehiculo!: string;

  @IsDateString()
  fecha_fin!: string;
}
