import type { Meta, StoryObj } from "@storybook/react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./Card";
import { Button } from "./Button";

const meta = {
  title: "UI/Card",
  component: Card,
  tags: ["autodocs"],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  render: () => (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Loan #4821</CardTitle>
        <CardDescription>Active &middot; next payment in 6 days</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-gray-500">Principal</dt>
          <dd className="text-right font-medium">$1,200.00</dd>
          <dt className="text-gray-500">APR</dt>
          <dd className="text-right font-medium">8.5%</dd>
        </dl>
      </CardContent>
      <CardFooter className="justify-end">
        <Button size="sm" variant="outline">
          View details
        </Button>
      </CardFooter>
    </Card>
  ),
};
