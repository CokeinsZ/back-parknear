import { sql } from 'drizzle-orm';
import { integer, pgEnum, pgTable, timestamp, uuid, varchar, text, decimal, serial, date, time, primaryKey } from 'drizzle-orm/pg-core';

export const estadoUsuarioEnum = pgEnum('estado_usuario', [
  'activo',
  'no_verificado',
  'inactivo',
  'eliminado',
]);

export type EstadoUsuario = (typeof estadoUsuarioEnum.enumValues)[number];

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

export const controladores = pgTable('controladores', {
  id: uuid('id')
    .primaryKey()
    .references(() => usuarios.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  estado: estadoUsuarioEnum('estado'),
});

export const zonas_azules = pgTable('zonas_azules', {
  id: serial('id').primaryKey(),
  latitud: decimal('latitud', { precision: 9, scale: 6 }).notNull(),
  longitud: decimal('longitud', { precision: 9, scale: 6 }).notNull(),
  indicaciones: text('indicaciones'),
  capacidad: integer('capacidad').notNull().default(0),
  capacidad_total: integer('capacidad_total').notNull().default(0),
});

export const horario_zona = pgTable('horario_zona', {
  id_zona: integer('id_zona').notNull().references(() => zonas_azules.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  id_controlador: uuid('id_controlador').notNull().references(() => controladores.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  fecha: date('fecha').notNull(),
  hora_inicio: time('hora_inicio').notNull().default('08:00:00'),
  hora_fin: time('hora_fin').notNull().default('18:00:00'),
}, (table) => {
  return [
    primaryKey({ columns: [table.id_zona, table.id_controlador, table.fecha] }),
  ];
});
