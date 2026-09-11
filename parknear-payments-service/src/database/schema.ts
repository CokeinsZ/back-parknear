import { sql } from 'drizzle-orm';
import {
  decimal,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const estadoUsuarioEnum = pgEnum('estado_usuario', [
  'activo',
  'no_verificado',
  'inactivo',
  'eliminado',
]);

export const estadoReservaEnum = pgEnum('estado_reserva', [
  'activa',
  'pendiente',
  'cancelada',
  'completada',
]);

export const metodoPagoEnum = pgEnum('metodo_pago', ['efectivo', 'mercadopago']);
export const estadoPagoEnum = pgEnum('estado_pago', [
  'pendiente',
  'aprobado',
  'rechazado',
  'reembolzado',
]);

export const usuarios = pgTable('usuarios', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  documento_identidad: varchar('documento_identidad', { length: 20 }).notNull(),
  primer_nombre: varchar('primer_nombre', { length: 32 }).notNull(),
  segundo_nombre: varchar('segundo_nombre', { length: 32 }),
  primer_apellido: varchar('primer_apellido', { length: 32 }).notNull(),
  segundo_apellido: varchar('segundo_apellido', { length: 32 }),
  email: varchar('email', { length: 255 }).notNull(),
  contrasena: varchar('contrasena', { length: 255 }).notNull(),
  celular: varchar('celular', { length: 13 }).notNull(),
  estado: estadoUsuarioEnum('estado').notNull().default('inactivo'),
  fecha_creacion: timestamp('fecha_creacion', { mode: 'date' }).notNull().defaultNow(),
  fecha_actualizacion: timestamp('fecha_actualizacion', {
    mode: 'date',
  })
    .notNull()
    .defaultNow(),
});

export const conductores = pgTable('conductores', {
  id: uuid('id')
    .primaryKey()
    .references(() => usuarios.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  puntos_fidelidad: integer('puntos_fidelidad').notNull().default(0),
  estado: estadoUsuarioEnum('estado').notNull(),
});

export const vehiculos = pgTable('vehiculos', {
  placa: varchar('placa', { length: 10 }).primaryKey(),
  id_conductor: uuid('id_conductor').references(() => conductores.id, {
    onDelete: 'restrict',
    onUpdate: 'cascade',
  }),
  marca: varchar('marca', { length: 32 }),
  color: varchar('color', { length: 32 }),
});

export const controladores = pgTable('controladores', {
  id: uuid('id')
    .primaryKey()
    .references(() => usuarios.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  estado: estadoUsuarioEnum('estado'),
});


export const zonasAzules = pgTable('zonas_azules', {
  id: serial('id').primaryKey(),
  latitud: decimal('latitud', { precision: 9, scale: 6 }).notNull(),
  longitud: decimal('longitud', { precision: 9, scale: 6 }).notNull(),
  indicaciones: text('indicaciones'),
  capacidad: integer('capacidad').notNull().default(0),
  capacidad_total: integer('capacidad_total').notNull().default(0),
});

export const reservas = pgTable('reservas', {
  id: serial('id').primaryKey(),
  id_conductor: uuid('id_conductor').references(() => conductores.id, {
    onDelete: 'restrict',
    onUpdate: 'cascade',
  }),
  id_zona: integer('id_zona').references(() => zonasAzules.id, {
    onDelete: 'restrict',
    onUpdate: 'cascade',
  }),
  id_vehiculo: varchar('id_vehiculo', { length: 10 }).references(() => vehiculos.placa, {
    onDelete: 'set null',
    onUpdate: 'cascade',
  }),
  fecha_real_inicio: timestamp('fecha_real_inicio', { mode: 'date' }).notNull(),
  fecha_fin: timestamp('fecha_fin', { mode: 'date' }),
  precio: decimal('precio', { precision: 7, scale: 2 }).notNull().default('0'),
  estado: estadoReservaEnum('estado').notNull().default('pendiente'),
  fecha_creacion: timestamp('fecha_creacion', { mode: 'date' }).notNull().defaultNow(),
  fecha_actualizacion: timestamp('fecha_actualizacion', { mode: 'date' }).notNull().defaultNow(),
});

export const pagos = pgTable('pagos', {
  id: serial('id').primaryKey(),
  id_reserva: integer('id_reserva').references(() => reservas.id, {
    onDelete: 'restrict',
    onUpdate: 'cascade',
  }),
  mp_id_transaccion: varchar('mp_id_transaccion', { length: 255 }),
  mp_payload: jsonb('mp_payload'),
  monto: decimal('monto', { precision: 7, scale: 2 }).notNull().default('0'),
  metodo: metodoPagoEnum('metodo').notNull(),
  estado: estadoPagoEnum('estado').notNull().default('pendiente'),
  anotaciones: text('anotaciones'),
  fecha_creacion: timestamp('fecha_creacion', { mode: 'date' }).defaultNow(),
  fecha_actualizacion: timestamp('fecha_actualizacion', { mode: 'date' }).defaultNow(),
});