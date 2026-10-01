import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './plan.entity.js';

export interface DefaultPlan {
  name: string;
  description: string;
  maxUsers: number;
  maxProjects: number;
  maxStorageGb: number;
  maxOrganizations: number;
  price: string;
}

/** Built-in plan catalogue seeded on first boot (spec §4.2). */
export const DEFAULT_PLANS: DefaultPlan[] = [
  {
    name: 'Starter',
    description:
      'Single workspace for a small team getting started with delivery tracking.',
    maxUsers: 5,
    maxProjects: 3,
    maxStorageGb: 5,
    maxOrganizations: 1,
    price: '19.00',
  },
  {
    name: 'Growth',
    description: 'Multiple workspaces for growing delivery teams.',
    maxUsers: 25,
    maxProjects: 25,
    maxStorageGb: 50,
    maxOrganizations: 3,
    price: '79.00',
  },
  {
    name: 'Business',
    description: 'Scale plan with generous limits across every organization.',
    maxUsers: 100,
    maxProjects: 200,
    maxStorageGb: 500,
    maxOrganizations: 10,
    price: '299.00',
  },
];

@Injectable()
export class PlanService implements OnModuleInit {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,
  ) {}

  /** The built-in catalogue must exist before anyone can subscribe. */
  async onModuleInit(): Promise<void> {
    const seeded = await this.seedDefaults();
    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} default plans`);
    }
  }

  async findAll(): Promise<Plan[]> {
    return this.planRepo.find({ order: { price: 'ASC' } });
  }

  async findById(id: string): Promise<Plan | null> {
    return this.planRepo.findOne({ where: { id } });
  }

  async requireById(id: string): Promise<Plan> {
    const plan = await this.findById(id);
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }
    return plan;
  }

  async count(): Promise<number> {
    return this.planRepo.count();
  }

  /** Idempotent: creates the built-in plan catalogue only when it is missing. */
  async seedDefaults(): Promise<number> {
    if ((await this.count()) > 0) {
      return 0;
    }
    const plans = this.planRepo.create(DEFAULT_PLANS);
    await this.planRepo.save(plans);
    return plans.length;
  }
}
