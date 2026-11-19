import { auth } from "@/lib/auth"
import { isAdminUsername } from "@/lib/admin-auth"
import { redirect } from "next/navigation"
import { cache } from "react"

export const requireAdminPage = cache(async () => {
    const session = await auth()
    const user = session?.user
    if (!user?.username || !isAdminUsername(user.username)) redirect("/")
    return { ...user, username: user.username }
})
