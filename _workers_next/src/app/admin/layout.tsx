import { requireAdminPage } from "@/lib/admin-page"
import { AdminSidebar } from "@/components/admin/sidebar"
import { UpdateNotification } from "@/components/admin/update-notification"
import { getSetting } from "@/lib/db/queries"
import { RegistryPrompt } from "@/components/admin/registry-prompt"
import { isRegistryEnabled } from "@/lib/registry"
import { APP_VERSION } from "@/lib/version"

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = await requireAdminPage()

    const registryEnabled = isRegistryEnabled()
    let registryPrompted = null
    let registryOptIn = null
    if (registryEnabled) {
        try {
            const [prompted, optIn] = await Promise.all([
                getSetting("registry_prompted"),
                getSetting("registry_opt_in"),
            ])
            registryPrompted = prompted
            registryOptIn = optIn
        } catch {
            registryPrompted = null
            registryOptIn = null
        }
    }

    const shouldPrompt = registryEnabled && registryPrompted !== "true" && registryOptIn !== "true"

    return (
        <div className="flex min-h-screen flex-col">
            <UpdateNotification currentVersion={APP_VERSION} />
            <RegistryPrompt shouldPrompt={shouldPrompt} registryEnabled={registryEnabled} />
            <div className="flex flex-1 flex-col md:flex-row">
                <AdminSidebar username={user.username} />
                <main className="flex-1 p-6 md:p-12 overflow-y-auto">
                    {children}
                </main>
            </div>
        </div>
    )
}
