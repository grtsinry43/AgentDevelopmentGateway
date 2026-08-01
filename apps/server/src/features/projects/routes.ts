import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { errorResponseSchema } from '../../http/schemas.js'
import type { ProjectService } from './service.js'
import {
  adaptersResponseSchema,
  createProjectBodySchema,
  listModelsQuerySchema,
  modelCatalogSchema,
  projectErrorResponses,
  projectAgentParamsSchema,
  projectListResponseSchema,
  projectParamsSchema,
  projectSchema
} from './schemas.js'

interface ProjectRoutesOptions {
  projects: ProjectService
}

export const projectRoutes: FastifyPluginAsyncZod<ProjectRoutesOptions> = async (
  server,
  options
) => {
  server.get(
    '/projects',
    { schema: { response: { 200: projectListResponseSchema, 500: errorResponseSchema } } },
    async () => ({ projects: await options.projects.list() })
  )

  server.post(
    '/projects',
    {
      schema: {
        body: createProjectBodySchema,
        response: { 201: projectSchema, ...projectErrorResponses }
      }
    },
    async (request, reply) => {
      const project = await options.projects.create(request.body)
      return reply.code(201).send(project)
    }
  )

  server.get(
    '/projects/:id',
    {
      schema: {
        params: projectParamsSchema,
        response: { 200: projectSchema, ...projectErrorResponses }
      }
    },
    async (request) => options.projects.get(request.params.id)
  )

  server.delete(
    '/projects/:id',
    {
      schema: {
        params: projectParamsSchema,
        response: { 204: z.undefined(), ...projectErrorResponses }
      }
    },
    async (request, reply) => {
      options.projects.remove(request.params.id)
      return reply.code(204).send()
    }
  )

  server.get(
    '/projects/:id/agents',
    {
      schema: {
        params: projectParamsSchema,
        response: { 200: adaptersResponseSchema, ...projectErrorResponses }
      }
    },
    async (request) => ({ adapters: await options.projects.inspectAdapters(request.params.id) })
  )

  server.get(
    '/projects/:id/agents/:adapterId/models',
    {
      schema: {
        params: projectAgentParamsSchema,
        querystring: listModelsQuerySchema,
        response: { 200: modelCatalogSchema, ...projectErrorResponses }
      }
    },
    async (request) =>
      options.projects.listModels(
        request.params.id,
        request.params.adapterId,
        request.query.installationPath
      )
  )
}
