/** Cuerpo de PUT y DELETE /auth/token-push. */
export class TokenPushDto {
  /** Token de Expo del teléfono: `ExponentPushToken[...]` (o `ExpoPushToken[...]`). */
  token!: string;
}
