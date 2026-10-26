import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { HORAS_MAX } from '../reglas';

export class ExtendReservaDto {
  /** Horas enteras que se suman a `fecha_fin`. La reserva completa no puede pasar de HORAS_MAX. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HORAS_MAX - 1)
  horas!: number;
}
