import { Command, CommandConfig } from './command'
import { EventEmitter } from 'events'
import { MessageMeta, Meta } from './meta'
import { Sender } from './sender'
import { App } from './app'
import { Database } from './database'
import * as messages from './messages'
import * as errors from './errors'

export type NextFunction = (next?: NextFunction) => any
export type Middleware = (meta: MessageMeta, next: NextFunction) => any

type PluginFunction <T extends Context, U> = (ctx: T, options: U) => void
type PluginObject <T extends Context, U> = { name?: string, apply: PluginFunction<T, U> }
export type Plugin <T extends Context = Context, U = any> = PluginFunction<T, U> | PluginObject<T, U>

export function isAncestor (ancestor: string, path: string) {
  return path.startsWith(ancestor) || path.replace(/\d+/, '*').startsWith(ancestor)
}

const prefixTypes = ['user', 'discuss', 'group']

export class Context {
  public id?: number
  public sender: Sender
  public database: Database
  public receiver = new EventEmitter()

  constructor (public path: string, public app?: App) {}

  plugin <U> (plugin: PluginFunction<this, U>, options?: U): this
  plugin <U> (plugin: PluginObject<this, U>, options?: U): this
  plugin <U> (plugin: Plugin<this, U>, options: any) {
    if (options === false) return
    const app = Object.create(this)
    if (typeof plugin === 'function') {
      plugin(app, options)
    } else if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') {
      plugin.apply(app, options)
      if ('name' in plugin) {
        this.app.receiver.emit('plugin', plugin.name)
      }
    }
    return this
  }

  middleware (middleware: Middleware) {
    this.app._middlewares.push([this.path, middleware])
    return this
  }

  premiddleware (middleware: Middleware) {
    this.app._middlewares.unshift([this.path, middleware])
    return this
  }

  removeMiddleware (middleware: Middleware) {
    const index = this.app._middlewares.findIndex(([p, m]) => p === this.path && m === middleware)
    if (index >= 0) {
      this.app._middlewares.splice(index, 1)
      return true
    }
  }

  private _getCommandByParent (name: string, parent?: Command) {
    let command = this.app._commandMap[name.toLowerCase()]
    if (command) {
      if (parent && command.parent !== parent) {
        throw new Error(errors.WRONG_SUBCOMMAND)
      }
      if (!isAncestor(command.context.path, this.path)) {
        throw new Error(errors.WRONG_CONTEXT)
      }
      return command
    }
    if (parent && !isAncestor(parent.context.path, this.path)) {
      throw new Error(errors.WRONG_CONTEXT)
    }
    command = new Command(name, this)
    if (parent) {
      command.parent = parent
      parent.children.push(command)
    }
    return command
  }

  command (rawName: string, config?: CommandConfig): Command
  command (rawName: string, description: string, config?: CommandConfig): Command
  command (rawName: string, ...args: [CommandConfig?] | [string, CommandConfig?]) {
    const description = typeof args[0] === 'string' ? args.shift() as string : undefined
    const config = { description, ...args[0] as CommandConfig }

    const [name] = rawName.split(/\s/, 1)
    const declaration = rawName.slice(name.length)
    const segments = name.split(/(?=[\\./])/)
    let command: Command
    segments.forEach((name, index) => {
      if (index === segments.length - 1) name += declaration
      if (!index) return command = this._getCommandByParent(name)
      if (name.charCodeAt(0) === 46) {
        command = this._getCommandByParent(command.name + name, command)
      } else {
        command = this._getCommandByParent(name.slice(1), command)
      }
    })

    Object.assign(command.config, config)
    return command
  }

  private _getCommandByRawName (name: string) {
    name = name.split(' ', 1)[0]
    const index = name.lastIndexOf('/')
    return this.app._commandMap[name.slice(index + 1).toLowerCase()]
  }

  getCommand (name: string, meta?: MessageMeta) {
    const path = meta ? meta.$path : this.path
    const command = this._getCommandByRawName(name)
    return command && isAncestor(command.context.path, path) && command
  }

  runCommand (name: string, meta: MessageMeta, args: string[] = [], options: Record<string, any> = {}, rest = '') {
    const command = this._getCommandByRawName(name)
    if (!command || !isAncestor(command.context.path, meta.$path)) {
      return meta.$send(messages.COMMAND_NOT_FOUND)
    }
    return command.execute({ meta, command, args, options, rest, unknown: [] })
  }

  end () {
    return this.app
  }

  _getEventTypes (path: string) {
    if (path.startsWith(this.path)) {
      let lastEvent = ''
      const events: string[] = []
      for (let segment of path.slice(this.path.length).split('/')) {
        if (!isNaN(segment as any) || prefixTypes.includes(segment)) segment = lastEvent ? '*' : ''
        if (segment) events.push(lastEvent = lastEvent ? `${lastEvent}/${segment}` : segment)
      }
      return events
    } else {
      return []
    }
  }
}

type UserMessageEvent = 'message' | 'message/friend' | 'message/group' | 'message/discuss' | 'message/other'
type GroupMessageEvent = 'message' | 'message/normal' | 'message/notice' | 'message/anonymous'
type DiscussMessageEvent = 'message'
type UserNoticeEvent = 'friend_add'
type GroupNoticeEvent = 'group_increase' | 'group_increase/approve' | 'group_increase/invite'
  | 'group_decrease' | 'group_decrease/leave' | 'group_decrease/kick' | 'group_decrease/kick_me'
  | 'group_upload' | 'group_admin' | 'group_admin/unset' | 'group_admin/set' | 'group_ban'
type UserRequestEvent = 'request'
type GroupRequestEvent = 'request' | 'request/add' | 'request/invite'

export type MessageEvent = UserMessageEvent | GroupMessageEvent | DiscussMessageEvent
export type NoticeEvent = UserNoticeEvent | GroupNoticeEvent
export type RequestEvent = UserRequestEvent | GroupRequestEvent
export type MetaEventEvent = 'meta_event' | 'meta_event/heartbeat'
  | 'meta_event/lifecycle' | 'meta_event/lifecycle/enable' | 'meta_event/lifecycle/disable'

interface UserReceiver extends EventEmitter {
  on (event: 'send', listener: (meta: Meta<'send'>) => any): this
  on (event: UserNoticeEvent, listener: (meta: Meta<'notice'>) => any): this
  on (event: UserMessageEvent, listener: (meta: Meta<'message'>) => any): this
  on (event: UserRequestEvent, listener: (meta: Meta<'request'>) => any): this
  once (event: 'send', listener: (meta: Meta<'send'>) => any): this
  once (event: UserNoticeEvent, listener: (meta: Meta<'notice'>) => any): this
  once (event: UserMessageEvent, listener: (meta: Meta<'message'>) => any): this
  once (event: UserRequestEvent, listener: (meta: Meta<'request'>) => any): this
}

interface GroupReceiver extends EventEmitter {
  on (event: 'send', listener: (meta: Meta<'send'>) => any): this
  on (event: GroupNoticeEvent, listener: (meta: Meta<'notice'>) => any): this
  on (event: GroupMessageEvent, listener: (meta: Meta<'message'>) => any): this
  on (event: GroupRequestEvent, listener: (meta: Meta<'request'>) => any): this
  once (event: 'send', listener: (meta: Meta<'send'>) => any): this
  once (event: GroupNoticeEvent, listener: (meta: Meta<'notice'>) => any): this
  once (event: GroupMessageEvent, listener: (meta: Meta<'message'>) => any): this
  once (event: GroupRequestEvent, listener: (meta: Meta<'request'>) => any): this
}

export interface DiscussReceiver extends EventEmitter {
  on (event: 'send', listener: (meta: Meta<'send'>) => any): this
  on (event: DiscussMessageEvent, listener: (meta: Meta<'message'>) => any): this
  once (event: 'send', listener: (meta: Meta<'send'>) => any): this
  once (event: DiscussMessageEvent, listener: (meta: Meta<'message'>) => any): this
}

export interface UserContext extends Context {
  receiver: UserReceiver
}

export interface GroupContext extends Context {
  receiver: GroupReceiver
}

export interface DiscussContext extends Context {
  receiver: DiscussReceiver
}
