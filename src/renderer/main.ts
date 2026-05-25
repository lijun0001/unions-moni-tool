import { createApp } from 'vue'
import * as Vue from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import App from './App.vue'
import { router } from './router'
import { bindAppRouter } from './navigation'
import './style.css'

import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

window.__UNIONS_VUE__ = Vue

const app = createApp(App)
app.use(createPinia())
bindAppRouter(router)
app.use(router)
app.use(ElementPlus)
app.mount('#app')
