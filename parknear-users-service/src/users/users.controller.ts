import { Controller, Get, Post, Body, Param, UseGuards, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles } from './roles.decorator';
import { RolesGuard } from './guards/roles.guard';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Get()
  async findAll() {
    return this.usersService.findAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Get(':email')
  async findByEmail(@Param('email') email: string) {
    return this.usersService.findByEmail(email);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONDUCTOR')
  @Post(':documento/vehiculo')
  addVehiculo(@Param('documento') documento: string, @Body() vehiculoDto: any) {
    return this.usersService.addVehiculo(documento, vehiculoDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONDUCTOR')
  @Get(':documento/vehiculos')
  getVehiculos(@Param('documento') documento: string) {
    return this.usersService.getVehiculos(documento);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Patch(':documento') update(@Param('documento') documento: string,@Body() updateDto: any) {
    return this.usersService.update(documento, updateDto);
  }
}