import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', children: [] },
  {
    path: 'library',
    loadComponent: () => import('./features/library/library').then((module) => module.Library),
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then((module) => module.Settings),
  },
  {
    path: 'logs',
    loadComponent: () => import('./features/logs/logs').then((module) => module.Logs),
  },
  { path: '**', redirectTo: '' },
];
