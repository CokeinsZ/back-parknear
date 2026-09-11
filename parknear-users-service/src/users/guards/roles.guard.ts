import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.get<string[]>('roles', context.getHandler());

    if (!requiredRoles) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as { tipo_usuario?: string };

    const normalizedRoles = requiredRoles.map((role) => role.toLowerCase());
    const userRole = (user?.tipo_usuario ?? '').toLowerCase();

    return normalizedRoles.includes(userRole);
  }
}