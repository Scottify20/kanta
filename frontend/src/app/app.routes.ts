import { Routes } from '@angular/router';
import { NowPlaying } from './features/now-playing/now-playing';

export const routes: Routes = [
  { path: '', component: NowPlaying },
  {
    path: 'library',
    loadComponent: () => import('./features/library/library').then((module) => module.Library),
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then((module) => module.Settings),
  },
  { path: '**', redirectTo: '' },
];
