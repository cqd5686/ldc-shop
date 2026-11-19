import { requireAdminPage } from "@/lib/admin-page"
import ProductForm from "@/components/admin/product-form"
import { getCategories } from "@/lib/db/queries"

export default async function NewProductPage() {
    await requireAdminPage()
    const categories = await getCategories()
    return <ProductForm categories={categories} />
}
