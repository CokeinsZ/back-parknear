import { EstadoUsuario } from 'src/database/schema';

export class CreateUserDto {
  documento_identidad!: string;
  primer_nombre!: string;
  segundo_nombre?: string;
  primer_apellido!: string;
  segundo_apellido?: string;
  email!: string;
  contrasena!: string;
  celular!: string;
  estado?: EstadoUsuario;
  tipo_usuario?: 'conductor' | 'controlador';
}