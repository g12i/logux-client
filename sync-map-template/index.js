import { mapTemplate, clean, startTask, task } from 'nanostores'
import { isFirstOlder } from '@logux/core'

import { LoguxUndoError } from '../logux-undo-error/index.js'
import { track } from '../track/index.js'

function changeIfLast(store, fields, meta) {
  let changes = {}
  for (let key in fields) {
    if (!meta || isFirstOlder(store.lastChanged[key], meta)) {
      changes[key] = fields[key]
      if (meta) store.lastChanged[key] = meta
    }
  }
  for (let key in changes) {
    store.setKey(key, changes[key])
  }
}

function getIndexes(plural, id) {
  return [plural, `${plural}/${id}`]
}

export function syncMapTemplate(plural, opts = {}) {
  let Template = mapTemplate(
    (store, id, client, createAction, createMeta, alreadySubscribed) => {
      if (!client) {
        throw new Error('Missed Logux client')
      }

      function saveProcessAndClean(fields, meta) {
        for (let key in fields) {
          if (isFirstOlder(store.lastProcessed[key], meta)) {
            store.lastProcessed[key] = meta
          }
          store.client.log.removeReason(`${store.plural}/${id}/${key}`, {
            olderThan: store.lastProcessed[key]
          })
        }
      }

      store.plural = plural
      store.client = client
      store.offline = Template.offline
      store.remote = Template.remote

      store.lastChanged = {}
      store.lastProcessed = {}

      let deletedType = `${plural}/deleted`
      let deleteType = `${plural}/delete`
      let createdType = `${plural}/created`
      let createType = `${plural}/create`
      let changeType = `${plural}/change`
      let changedType = `${plural}/changed`
      let subscribe = { type: 'logux/subscribe', channel: `${plural}/${id}` }

      let loadingError
      let isLoading = true
      store.setKey('isLoading', true)

      if (createAction) {
        for (let key in createAction.fields) {
          store.setKey(key, createAction.fields[key])
          store.lastChanged[key] = createMeta
        }
        isLoading = false
        store.loading = Promise.resolve()
        store.setKey('isLoading', false)
        store.createdAt = createMeta
        if (createAction.type === createType) {
          track(client, createMeta.id)
            .then(() => {
              saveProcessAndClean(createAction.fields, createMeta)
            })
            .catch(() => {})
        }
        if (store.remote && !alreadySubscribed) {
          client.log.add({ ...subscribe, creating: true }, { sync: true })
        }
      } else {
        let endTask = startTask()
        let loadingResolve, loadingReject
        store.loading = new Promise((resolve, reject) => {
          loadingResolve = () => {
            resolve()
            endTask()
          }
          loadingReject = e => {
            reject(e)
            endTask()
          }
        })
        if (store.remote) {
          client
            .sync(subscribe)
            .then(() => {
              if (isLoading) {
                isLoading = false
                store.setKey('isLoading', false)
                loadingResolve()
              }
            })
            .catch(e => {
              loadingError = true
              loadingReject(e)
            })
        }
        if (store.offline) {
          let found
          client.log
            .each({ index: `${plural}/${id}` }, (action, meta) => {
              let type = action.type
              if (action.id === id) {
                if (
                  type === changedType ||
                  type === changeType ||
                  type === createdType ||
                  type === createType
                ) {
                  changeIfLast(store, action.fields, meta)
                  found = true
                } else if (type === deletedType || type === deleteType) {
                  return false
                }
              }
              return undefined
            })
            .then(() => {
              if (found && isLoading) {
                isLoading = false
                store.setKey('isLoading', false)
                loadingResolve()
              } else if (!found && !store.remote) {
                loadingReject(
                  new LoguxUndoError({
                    type: 'logux/undo',
                    reason: 'notFound',
                    id: client.log.generateId(),
                    action: subscribe
                  })
                )
              }
            })
        }
      }

      let reasonsForFields = (action, meta) => {
        for (let key in action.fields) {
          if (isFirstOlder(store.lastProcessed[key], meta)) {
            meta.reasons.push(`${plural}/${id}/${key}`)
          }
        }
      }

      let removeReasons = () => {
        for (let key in store.lastChanged) {
          client.log.removeReason(`${plural}/${id}/${key}`)
        }
      }

      let setFields = (action, meta) => {
        changeIfLast(store, action.fields, meta)
        saveProcessAndClean(action.fields, meta)
      }

      let setIndexes = (action, meta) => {
        meta.indexes = getIndexes(plural, action.id)
      }

      let unbinds = [
        client.type(changedType, setIndexes, { event: 'preadd', id }),
        client.type(changeType, setIndexes, { event: 'preadd', id }),
        client.type(deletedType, setIndexes, { event: 'preadd', id }),
        client.type(deleteType, setIndexes, { event: 'preadd', id }),
        client.type(createdType, reasonsForFields, { event: 'preadd', id }),
        client.type(changedType, reasonsForFields, { event: 'preadd', id }),
        client.type(changeType, reasonsForFields, { event: 'preadd', id }),
        client.type(deletedType, removeReasons, { id }),
        client.type(
          deleteType,
          async (action, meta) => {
            await task(async () => {
              try {
                await track(client, meta.id)
                removeReasons()
              } catch {
                await client.log.changeMeta(meta.id, { reasons: [] })
              }
            })
          },
          { id }
        ),
        client.type(createdType, setFields, { id }),
        client.type(changedType, setFields, { id }),
        client.type(
          changeType,
          async (action, meta) => {
            let endTask = startTask()
            changeIfLast(store, action.fields, meta)
            try {
              await track(client, meta.id)
              saveProcessAndClean(action.fields, meta)
              if (store.offline) {
                client.log.add(
                  { ...action, type: changedType },
                  { time: meta.time }
                )
              }
              endTask()
            } catch {
              client.log.changeMeta(meta.id, { reasons: [] })
              let reverting = new Set(Object.keys(action.fields))
              client.log
                .each({ index: `${plural}/${id}` }, (a, m) => {
                  if (a.id === id && m.id !== meta.id) {
                    if (
                      (a.type === changeType ||
                        a.type === changedType ||
                        a.type === createType ||
                        a.type === createdType) &&
                      Object.keys(a.fields).some(i => reverting.has(i))
                    ) {
                      let revertDiff = {}
                      for (let key in a.fields) {
                        if (reverting.has(key)) {
                          delete store.lastChanged[key]
                          reverting.delete(key)
                          revertDiff[key] = a.fields[key]
                        }
                      }
                      changeIfLast(store, revertDiff, m)
                      return reverting.size === 0 ? false : undefined
                    } else if (
                      a.type === deleteType ||
                      a.type === deletedType
                    ) {
                      return false
                    }
                  }
                  return undefined
                })
                .then(() => {
                  for (let key of reverting) {
                    store.setKey(key, undefined)
                  }
                  endTask()
                })
            }
          },
          { id }
        )
      ]

      if (store.remote) {
        unbinds.push(() => {
          if (!loadingError) {
            client.log.add(
              { type: 'logux/unsubscribe', channel: subscribe.channel },
              { sync: true }
            )
          }
        })
      }

      return () => {
        for (let i of unbinds) i()
        if (!store.offline) {
          for (let key in store.lastChanged) {
            client.log.removeReason(`${plural}/${id}/${key}`)
          }
        }
      }
    }
  )

  Template.plural = plural
  Template.offline = !!opts.offline
  Template.remote = opts.remote !== false

  if (process.env.NODE_ENV !== 'production') {
    let oldClean = Template[clean]
    Template[clean] = () => {
      oldClean()
      if (Template.filters) {
        for (let id in Template.filters) {
          Template.filters[id][clean]()
        }
        delete Template.filters
      }
    }
  }

  return Template
}

function addSyncAction(client, Template, action) {
  let meta = { indexes: getIndexes(Template.plural, action.id) }
  if (!Template.remote) {
    action.type += 'd'
  }
  if (Template.remote) {
    return task(() => client.sync(action, meta))
  } else {
    return task(() => client.log.add(action, meta))
  }
}

export function createSyncMap(client, Template, value) {
  let { id, ...fields } = value
  return addSyncAction(client, Template, {
    type: `${Template.plural}/create`,
    id,
    fields
  })
}

export async function buildNewSyncMap(client, Template, value) {
  let { id, ...fields } = value
  let actionId = client.log.generateId()

  let verb = Template.remote ? 'create' : 'created'
  let type = `${Template.plural}/${verb}`
  let action = { type, id, fields }
  let meta = {
    id: actionId,
    time: parseInt(actionId),
    indexes: getIndexes(Template.plural, id)
  }
  if (Template.remote) meta.sync = true
  await task(() => client.log.add(action, meta))

  let store = Template(id, client, action, meta)
  return store
}

export function changeSyncMapById(client, Template, id, fields, value) {
  if (value) fields = { [fields]: value }
  return addSyncAction(client, Template, {
    type: `${Template.plural}/change`,
    id,
    fields
  })
}

export function changeSyncMap(store, fields, value) {
  if (value) fields = { [fields]: value }
  changeIfLast(store, fields)
  return changeSyncMapById(store.client, store, store.get().id, fields)
}

export function deleteSyncMapById(client, Template, id) {
  return addSyncAction(client, Template, {
    type: `${Template.plural}/delete`,
    id
  })
}

export function deleteSyncMap(store) {
  return deleteSyncMapById(store.client, store, store.get().id)
}
