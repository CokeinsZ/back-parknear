import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { HORAS_MAX, HORAS_MIN } from '../reglas';

/**
 * El conductor sale del token y el fin lo calcula el servidor (creación + horas)
 * con el reloj de la base de datos: no se aceptan `id_conductor` ni `fecha_fin`.
 */
export class CreateReservaDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id_zona!: number;

  /** Placa del vehículo; debe ser del conductor que reserva. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  id_vehiculo!: string;

  /** Horas enteras reservadas. */
  @Type(() => Number)
  @IsInt()
  @Min(HORAS_MIN)
  @Max(HORAS_MAX)
  horas!: number;
}
