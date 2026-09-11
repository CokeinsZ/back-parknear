import { IsDateString } from 'class-validator';

export class ExtendReservaDto {
  @IsDateString()
  fecha_fin!: string;
}
