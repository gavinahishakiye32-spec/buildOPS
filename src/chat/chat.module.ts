import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { Project } from '../project/project.entity.js';
import { Role } from '../role/role.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { User } from '../user/user.entity.js';
import { ChatEmitter } from './chat-emitter.js';
import {
  ChatChannel,
  ChatChannelParticipant,
  ChatMessage,
} from './chat.entity.js';
import { ChatController } from './chat.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [
    AuthModule,
    // `@Protected()` applies `PermissionsGuard`, which resolves the caller's
    // membership through `MembershipResolver` (bound in `RoleModule`), so the
    // guard has to be constructible here. The gateway resolves membership the
    // same way for the socket handshake.
    AuthorizationModule,
    TypeOrmModule.forFeature([
      ChatChannel,
      ChatMessage,
      ChatChannelParticipant,
      Role,
      User,
      // Scope records a room can be opened for; the service checks them
      // against the caller's organization before the room is ever touched.
      Project,
      Task,
      Subtask,
    ]),
  ],
  controllers: [ChatController],
  // The service depends on `ChatEmitter` to broadcast and the gateway depends
  // on the service to re-check access on socket events. Binding the emitter to
  // the gateway closes that loop, and the two `forwardRef`s (one in each
  // constructor) are what let Nest untangle it; see `chat-emitter.ts` for why
  // the interface exists at all.
  providers: [
    ChatService,
    ChatGateway,
    { provide: ChatEmitter, useExisting: ChatGateway },
  ],
  exports: [ChatService, ChatEmitter],
})
export class ChatModule {}
