export const profiles = {
  northstar: {
    name: "Northstar Fieldworks", industry: "industrial software", employees: 48,
    locations: ["Ithaca office", "Buffalo pilot site"],
    departments: ["Product Engineering", "Field Engineering", "Customer Success", "Sales", "Operations"],
    projects: ["Beacon", "Atlas", "Relay"], repositories: ["field-agent", "defect-models", "customer-console"],
    requester: "Maya Chen", purpose: "Buffalo Beacon pilot trip", category: "travel",
    sources: ["github", "cloud_usage", "field_travel", "device_register", "software_renewal"],
    story: "Atlas training retries coincide with rising GPU usage; correlation requires investigation.",
    unit: 100,
  },
  juniper: {
    name: "Juniper Table", industry: "restaurants", employees: 36,
    locations: ["Downtown", "Riverside", "Market Square"],
    departments: ["Kitchen", "Service", "Operations"], projects: [], repositories: [],
    requester: "Elena Park", purpose: "Urgent refrigerator maintenance at Riverside", category: "equipment",
    sources: ["pos", "ingredient_purchase", "food_waste", "rent", "utilities", "maintenance", "labor"],
    story: "Riverside food waste rises during a refrigerator outage; repair and ingredient purchases share a location.",
    unit: 200,
  },
  forge: {
    name: "Forge & Loom", industry: "light manufacturing", employees: 42,
    locations: ["East workshop", "West assembly"],
    departments: ["Production", "Logistics", "Operations"], projects: [], repositories: [],
    requester: "Sam Rivera", purpose: "Urgent West assembly machine maintenance", category: "maintenance",
    sources: ["purchase_order", "inventory", "equipment_lease", "freight", "maintenance", "customer_invoice"],
    story: "West assembly downtime coincides with expedited freight and raw-material replenishment.",
    unit: 300,
  },
};

export const categories = ["food", "rent", "utilities", "equipment", "software", "cloud", "labor", "materials", "freight", "maintenance", "travel", "insurance"];
export const domains = ["food_expense", "facilities", "physical_assets", "software_cloud_ai", "labor", "procurement_inventory", "cash", "liabilities", "revenue_receivables", "taxes_insurance", "governance"];
