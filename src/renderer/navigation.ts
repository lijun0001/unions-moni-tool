import type { Router } from 'vue-router'

let appRouter: Router | null = null

export function bindAppRouter(router: Router) {
  appRouter = router
}

export function getAppRouter(): Router | null {
  return appRouter
}
