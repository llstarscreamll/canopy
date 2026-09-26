import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, ActivatedRoute, Router, NavigationEnd } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { BrnDialogContent } from '@spartan-ng/brain/dialog';
import { filter } from 'rxjs';
import { TenantHttpService } from '../../../../tenant/infrastructure/tenant.http.service';
import { AuthStore } from '../../../../auth/application/auth.store';
import { TenantContextStore } from '../../../store/tenant-context.store';
import { EntitlementsStore } from '../../../../entitlements/application/entitlements.store';
import { PermissionsStore } from '../../../../rbac/application/permissions.store';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmBadgeImports } from '@spartan-ng/helm/badge';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSeparatorImports } from '@spartan-ng/helm/separator';
import { HlmSidebarImports, HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { PRODUCT_BUILD, APP_ENV, PRODUCT_RELEASED_AT, PRODUCT_REVISION, PRODUCT_VERSION } from '@atta/product';
import { SystemNoticesHostComponent } from '@canopy/system-notices/angular';
import { environment } from '../../../../../environments/environment';
import { InstallPromptHostComponent, PwaInstallCoordinator } from '../../../pwa-install';

type AboutApiInfo = {
  status: string;
  version: string;
  build: number;
  revision: string;
  released_at: string;
  environment: string;
  support_email?: string;
  terms_url?: string;
  privacy_url?: string;
  license_label?: string;
};

type AppEnv = 'local' | 'staging' | 'production';

@Component({
  selector: 'app-tenant-layout',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    NgIcon,
    BrnDialogContent,
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmAvatarImports,
    HlmBadgeImports,
    HlmButtonImports,
    HlmDialogImports,
    HlmSeparatorImports,
    HlmSpinnerImports,
    HlmTooltipImports,
    SystemNoticesHostComponent,
    InstallPromptHostComponent,
  ],
  template: `
    <div hlmSidebarWrapper class="h-screen w-full overflow-hidden">
      <hlm-sidebar collapsible="icon" side="left">
        <hlm-sidebar-header class="border-b border-sidebar-border">
          <div class="flex items-center gap-3 px-2 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
            <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <ng-icon name="lucideBird" class="text-lg" />
            </div>
            <span class="truncate font-bold tracking-tight group-data-[collapsible=icon]:hidden">Atta</span>
          </div>
        </hlm-sidebar-header>

        <hlm-sidebar-content>
          <hlm-sidebar-group class="group-data-[collapsible=icon]:hidden">
            <button hlmBtn variant="outline" class="h-auto w-full min-w-0 justify-between gap-2 overflow-hidden px-2.5 py-2" [hlmDropdownMenuTrigger]="tenantMenu">
              <div class="flex min-w-0 flex-1 items-center gap-2.5">
                <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <ng-icon name="lucideBuilding2" class="text-base" />
                </div>
                <div class="min-w-0 flex-1 text-left leading-tight">
                  <div class="truncate text-sm font-semibold [text-box:trim-both_cap_alphabetic]">{{ tenantName() }}</div>
                  <div class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <ng-icon name="lucideUsers" class="shrink-0 text-xs" />
                    <span class="truncate [text-box:trim-both_cap_alphabetic]">{{ tenantMembers() }} Miembro{{ tenantMembers() !== 1 ? 's' : '' }}</span>
                  </div>
                </div>
              </div>
              <ng-icon name="lucideChevronsUpDown" class="size-4 shrink-0 text-muted-foreground" />
            </button>
            <ng-template #tenantMenu>
              <hlm-dropdown-menu class="w-56">
                <a hlmDropdownMenuItem routerLink="/lobby" (click)="closeTenantMenu()">
                  <ng-icon name="lucideList" />
                  Todas las organizaciones
                </a>
                <hlm-separator class="my-1" />
                <a hlmDropdownMenuItem routerLink="/lobby" [queryParams]="{ create: true }" (click)="closeTenantMenu()">
                  <ng-icon name="lucideBuilding" />
                  Crear nueva organización
                </a>
              </hlm-dropdown-menu>
            </ng-template>
          </hlm-sidebar-group>

          <hlm-sidebar-group>
            <div hlmSidebarGroupLabel class="group-data-[collapsible=icon]:hidden">Navegación</div>
            <ul hlmSidebarMenu>
              <li hlmSidebarMenuItem>
                <a hlmSidebarMenuButton [routerLink]="['/', tenantId(), 'dashboard']" routerLinkActive #dashboardLink="routerLinkActive" [isActive]="dashboardLink.isActive" [tooltip]="'Dashboard'">
                  <ng-icon name="lucideLayoutDashboard" />
                  <span>Dashboard</span>
                </a>
              </li>
              @if (entitlements.hasMailInbox()) {
                <li hlmSidebarMenuItem>
                  <a
                    hlmSidebarMenuButton
                    [routerLink]="['/', tenantId(), 'inbox', 'master']"
                    routerLinkActive
                    #inboxLink="routerLinkActive"
                    [routerLinkActiveOptions]="{ exact: false }"
                    [isActive]="inboxLink.isActive"
                    [tooltip]="'Mails'"
                  >
                    <ng-icon name="lucideInbox" />
                    <span>Mails</span>
                  </a>
                </li>
              }
              @if (entitlements.hasInvoicing()) {
                <li hlmSidebarMenuItem>
                  <a
                    hlmSidebarMenuButton
                    [routerLink]="['/', tenantId(), 'invoices']"
                    routerLinkActive
                    #invoicesLink="routerLinkActive"
                    [isActive]="invoicesLink.isActive"
                    [tooltip]="'Facturas recibidas'"
                  >
                    <ng-icon name="lucideReceipt" />
                    <span>Facturas recibidas</span>
                  </a>
                </li>
                <li hlmSidebarMenuItem>
                  <a hlmSidebarMenuButton [routerLink]="['/', tenantId(), 'parties']" routerLinkActive #partiesLink="routerLinkActive" [isActive]="partiesLink.isActive" [tooltip]="'Contactos'">
                    <ng-icon name="lucideBuilding2" />
                    <span>Contactos</span>
                  </a>
                </li>
                <li hlmSidebarMenuItem>
                  <a
                    hlmSidebarMenuButton
                    [routerLink]="['/', tenantId(), 'catalog']"
                    routerLinkActive
                    #catalogLink="routerLinkActive"
                    [routerLinkActiveOptions]="{ exact: false }"
                    [isActive]="catalogLink.isActive"
                    [tooltip]="'Catálogo'"
                  >
                    <ng-icon name="lucidePackage" />
                    <span>Catálogo</span>
                  </a>
                </li>
              }
              @if (entitlements.showConnections()) {
                <li hlmSidebarMenuItem>
                  <a
                    hlmSidebarMenuButton
                    [routerLink]="['/', tenantId(), 'connections']"
                    routerLinkActive
                    #connectionsLink="routerLinkActive"
                    [routerLinkActiveOptions]="{ exact: false }"
                    [isActive]="connectionsLink.isActive"
                    [tooltip]="'Cuentas asociadas'"
                  >
                    <ng-icon name="lucideLink" />
                    <span>Cuentas</span>
                  </a>
                </li>
              }
              <li hlmSidebarMenuItem>
                <a hlmSidebarMenuButton [routerLink]="['/', tenantId(), 'settings']" routerLinkActive #settingsLink="routerLinkActive" [isActive]="settingsLink.isActive" [tooltip]="'Configuración'">
                  <ng-icon name="lucideSettings" />
                  <span>Configuración</span>
                </a>
              </li>
            </ul>
          </hlm-sidebar-group>

          <button
            type="button"
            class="mt-auto w-full px-4 py-2 text-right font-mono text-xs text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:px-0.5 group-data-[collapsible=icon]:text-center group-data-[collapsible=icon]:text-[10px] group-data-[collapsible=icon]:leading-tight"
            (click)="openAbout()"
          >
            <span class="group-data-[collapsible=icon]:hidden">Versión </span>{{ productVersion }}
          </button>
        </hlm-sidebar-content>

        <hlm-sidebar-footer class="border-t border-sidebar-border">
          <button hlmBtn variant="ghost" class="mb-2 w-full justify-between group-data-[collapsible=icon]:px-2" (click)="sidebarService.toggleSidebar()">
            <span class="group-data-[collapsible=icon]:hidden">Contraer menú</span>
            <ng-icon [name]="sidebarService.state() === 'collapsed' ? 'lucideChevronsRight' : 'lucideChevronsLeft'" />
          </button>

          <button hlmBtn variant="ghost" class="w-full justify-start gap-3 px-2" [hlmDropdownMenuTrigger]="userMenu">
            <hlm-avatar size="sm">
              @if (userAvatar(); as avatar) {
                <img hlmAvatarImage [src]="avatar" alt="User avatar" />
              }
              <span hlmAvatarFallback>{{ userInitials() }}</span>
            </hlm-avatar>
            <div class="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
              <div class="truncate text-sm font-medium">{{ userName() }}</div>
              <div class="truncate text-xs capitalize text-muted-foreground">{{ translatedRole() }}</div>
            </div>
            <ng-icon name="lucideChevronsUpDown" class="text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </button>
          <ng-template #userMenu>
            <hlm-dropdown-menu class="w-56">
              <div class="flex items-center justify-between px-2 py-1.5">
                <span class="text-sm font-medium">Tema</span>
                <div class="flex items-center rounded-full border bg-muted p-1">
                  <button type="button" hlmBtn size="icon-sm" [variant]="themeMode() === 'system' ? 'secondary' : 'ghost'" (click)="setTheme('system')" title="Sistema">
                    <ng-icon name="lucideMonitor" />
                  </button>
                  <button type="button" hlmBtn size="icon-sm" [variant]="themeMode() === 'light' ? 'secondary' : 'ghost'" (click)="setTheme('light')" title="Claro">
                    <ng-icon name="lucideSun" />
                  </button>
                  <button type="button" hlmBtn size="icon-sm" [variant]="themeMode() === 'dark' ? 'secondary' : 'ghost'" (click)="setTheme('dark')" title="Oscuro">
                    <ng-icon name="lucideMoon" />
                  </button>
                </div>
              </div>
              <hlm-separator class="my-1" />
              @if (installCoordinator.showMenuItem()) {
                <button hlmDropdownMenuItem (click)="openInstall()">
                  <ng-icon name="lucideDownload" />
                  Instalar aplicación
                </button>
                <hlm-separator class="my-1" />
              }
              <button hlmDropdownMenuItem variant="destructive" (click)="logout()">
                <ng-icon name="lucideLogOut" />
                Cerrar sesión
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        </hlm-sidebar-footer>
        <button hlmSidebarRail type="button" class="sr-only" aria-hidden="true"></button>
      </hlm-sidebar>

      <main hlmSidebarInset class="min-h-0 overflow-hidden bg-muted/30">
        <router-outlet />
      </main>
    </div>
    <bb-system-notices-host scope="tenant" />
    <app-install-prompt-host />

    <hlm-dialog [state]="aboutOpen() ? 'open' : 'closed'" (closed)="aboutOpen.set(false)">
      <hlm-dialog-content *brnDialogContent class="sm:max-w-lg">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Acerca del software</h2>
          <p hlmDialogDescription>Identidad de esta instalación. Úsala al reportar problemas.</p>
        </hlm-dialog-header>

        @if (aboutLoading()) {
          <div class="flex items-center justify-center py-8">
            <hlm-spinner class="size-6 text-primary" />
          </div>
        } @else {
          <div class="space-y-5 py-1 text-sm">
            <section class="space-y-2">
              <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Cliente (PWA)</h3>
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="text-muted-foreground">Entorno</span>
                <span hlmBadge class="font-mono text-xs" [variant]="environmentBadgeVariant(appEnv)">{{ environmentLabel(appEnv) }}</span>
              </div>
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt class="text-muted-foreground">Versión</dt>
                <dd class="text-right font-mono text-xs">{{ productVersion }}</dd>
                <dt class="text-muted-foreground">Build</dt>
                <dd class="text-right font-mono text-xs">{{ productBuild }}</dd>
                <dt class="text-muted-foreground">Revisión</dt>
                <dd class="text-right font-mono text-xs">{{ productRevision }}</dd>
                <dt class="text-muted-foreground">Fecha de release</dt>
                <dd class="text-right font-mono text-xs leading-snug">{{ formatReleasedAt(productReleasedAt) }}</dd>
              </dl>
            </section>

            <hlm-separator />

            <section class="space-y-2">
              <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Instalación (API)</h3>
              @if (aboutError(); as err) {
                <p class="text-sm text-destructive">{{ err }}</p>
              } @else if (aboutApi(); as api) {
                <div class="mb-3 flex items-center justify-between gap-2">
                  <span class="text-muted-foreground">Entorno</span>
                  <span hlmBadge class="font-mono text-xs" [variant]="environmentBadgeVariant(api.environment)">{{ environmentLabel(api.environment) }}</span>
                </div>
                <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                  <dt class="text-muted-foreground">Versión</dt>
                  <dd class="text-right font-mono text-xs">{{ api.version }}</dd>
                  <dt class="text-muted-foreground">Build</dt>
                  <dd class="text-right font-mono text-xs">{{ api.build }}</dd>
                  <dt class="text-muted-foreground">Revisión</dt>
                  <dd class="text-right font-mono text-xs">{{ api.revision }}</dd>
                  <dt class="text-muted-foreground">Fecha de release</dt>
                  <dd class="text-right font-mono text-xs leading-snug">{{ formatReleasedAt(api.released_at) }}</dd>
                </dl>
              }
            </section>

            <hlm-separator />

            <section class="space-y-2">
              <h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Soporte y legal</h3>
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt class="text-muted-foreground">Soporte</dt>
                <dd class="text-right">
                  @if (supportEmail(); as email) {
                    <a class="font-mono text-xs text-primary underline-offset-2 hover:underline" [href]="'mailto:' + email">{{ email }}</a>
                  } @else {
                    <span class="text-muted-foreground">—</span>
                  }
                </dd>
                <dt class="text-muted-foreground">Licencia</dt>
                <dd class="text-right">{{ aboutApi()?.license_label || 'Software propietario' }}</dd>
                @if (aboutApi()?.terms_url; as termsUrl) {
                  <dt class="text-muted-foreground">Términos</dt>
                  <dd class="text-right">
                    <a class="text-primary underline-offset-2 hover:underline" [href]="termsUrl" target="_blank" rel="noopener noreferrer">Ver términos</a>
                  </dd>
                }
                @if (aboutApi()?.privacy_url; as privacyUrl) {
                  <dt class="text-muted-foreground">Privacidad</dt>
                  <dd class="text-right">
                    <a class="text-primary underline-offset-2 hover:underline" [href]="privacyUrl" target="_blank" rel="noopener noreferrer">Ver política</a>
                  </dd>
                }
              </dl>
            </section>
          </div>
        }

        <hlm-dialog-footer>
          <button type="button" hlmBtn variant="outline" (click)="aboutOpen.set(false)">Cerrar</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class TenantLayoutComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private http = inject(HttpClient);
  private tenantService = inject(TenantHttpService);
  private authStore = inject(AuthStore);
  private tenantContextStore = inject(TenantContextStore);
  readonly entitlements = inject(EntitlementsStore);
  readonly permissions = inject(PermissionsStore);
  readonly sidebarService = inject(HlmSidebarService);
  readonly installCoordinator = inject(PwaInstallCoordinator);
  readonly productVersion = PRODUCT_VERSION;
  readonly productBuild = PRODUCT_BUILD;
  readonly productRevision = PRODUCT_REVISION;
  readonly productReleasedAt = PRODUCT_RELEASED_AT;
  readonly appEnv = APP_ENV;
  readonly aboutOpen = signal(false);
  readonly aboutLoading = signal(false);
  readonly aboutError = signal<string | null>(null);
  readonly aboutApi = signal<AboutApiInfo | null>(null);

  readonly supportEmail = computed(() => {
    const fromApi = this.aboutApi()?.support_email?.trim();
    if (fromApi) {
      return fromApi;
    }
    if (this.appEnv === 'local') {
      return 'soporte@atta.com';
    }
    return null;
  });

  themeMode = signal<'system' | 'light' | 'dark'>('system');

  tenantId = this.tenantContextStore.tenantId;
  tenantDetails = this.tenantContextStore.tenantDetails;

  private get decodedToken(): any {
    const token = this.authStore.accessToken();
    if (!token) return null;
    try {
      const payload = token.split('.')[1];
      return JSON.parse(atob(payload));
    } catch {
      return null;
    }
  }

  userName = computed(() => {
    const claims = this.decodedToken;
    if (!claims) return 'Usuario';
    return `${claims.first_name || ''} ${claims.last_name || ''}`.trim() || 'Usuario';
  });

  userInitials = computed(() => {
    const claims = this.decodedToken;
    if (!claims) return 'U';
    return (claims.first_name?.[0] || '') + (claims.last_name?.[0] || '') || 'U';
  });

  userAvatar = computed(() => this.decodedToken?.picture_url || null);

  translatedRole = computed(() => {
    const role = this.tenantDetails()?.current_user_role;
    switch (role) {
      case 'owner':
        return 'Propietario';
      case 'admin':
        return 'Administrador';
      case 'member':
        return 'Miembro';
      default:
        return role || 'Miembro';
    }
  });

  tenantName = computed(() => {
    const details = this.tenantDetails();
    if (details) return details.name;

    const id = this.tenantId();
    if (!id) return 'Cargando...';
    return id
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  });

  tenantMembers = computed(() => {
    const details = this.tenantDetails();
    return details?.members_count ?? 0;
  });

  ngOnInit() {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (savedTheme) {
      this.themeMode.set(savedTheme);
      document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    } else {
      this.themeMode.set('system');
      document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme')) {
        document.documentElement.classList.toggle('dark', e.matches);
      }
    });

    this.updateTenantId();

    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
      this.updateTenantId();
    });
  }

  closeTenantMenu() {}

  openAbout(): void {
    this.aboutOpen.set(true);
    this.aboutLoading.set(true);
    this.aboutError.set(null);
    this.http.get<AboutApiInfo>(`${environment.apiUrl}/api/health`).subscribe({
      next: (payload) => {
        this.aboutApi.set(payload);
        this.aboutLoading.set(false);
      },
      error: () => {
        this.aboutApi.set(null);
        this.aboutError.set('No se pudo obtener la información del API.');
        this.aboutLoading.set(false);
      },
    });
  }

  environmentLabel(value: string): string {
    switch (value as AppEnv) {
      case 'staging':
        return 'Staging';
      case 'production':
        return 'Production';
      case 'local':
      default:
        return 'Local';
    }
  }

  environmentBadgeVariant(value: string): 'default' | 'secondary' | 'outline' {
    switch (value as AppEnv) {
      case 'production':
        return 'default';
      case 'staging':
        return 'secondary';
      case 'local':
      default:
        return 'outline';
    }
  }

  formatReleasedAt(value: string): string {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return value;
    }
    return new Intl.DateTimeFormat('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(parsed));
  }

  openInstall(): void {
    void this.installCoordinator.openFromMenu();
  }

  logout() {
    this.authStore.logout({
      onFinish: () => this.router.navigate(['/login']),
    });
  }

  setTheme(mode: 'system' | 'light' | 'dark') {
    this.themeMode.set(mode);
    if (mode === 'system') {
      localStorage.removeItem('theme');
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', isDark);
    } else {
      localStorage.setItem('theme', mode);
      document.documentElement.classList.toggle('dark', mode === 'dark');
    }
  }

  private updateTenantId() {
    let currentRoute: ActivatedRoute | null = this.route;
    let newTenantId = '';

    while (currentRoute) {
      if (currentRoute.snapshot.paramMap.has('tenantId')) {
        newTenantId = currentRoute.snapshot.paramMap.get('tenantId')!;
        break;
      }
      currentRoute = currentRoute.firstChild;
    }

    if (newTenantId && newTenantId !== this.tenantId()) {
      this.tenantContextStore.setTenantId(newTenantId);
      this.entitlements.load(newTenantId).subscribe();
      this.permissions.load(newTenantId).subscribe();
    } else if (newTenantId && this.entitlements.loadedTenantId() !== newTenantId) {
      this.entitlements.load(newTenantId).subscribe();
      this.permissions.load(newTenantId).subscribe();
    } else if (newTenantId && this.permissions.loadedTenantId() !== newTenantId) {
      this.permissions.load(newTenantId).subscribe();
    }
  }
}
