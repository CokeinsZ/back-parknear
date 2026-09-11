import { sql } from 'drizzle-orm';
import { integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

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

export const admin = pgTable('admin', {
  id: uuid('id')
    .primaryKey()
    .references(() => usuarios.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  estado: estadoUsuarioEnum('estado').notNull().default('activo'),
});
