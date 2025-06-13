import React, { useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Icon,
  Badge,
} from "@shopify/polaris";
import { XIcon, UploadIcon, OrderIcon, EditIcon } from "@shopify/polaris-icons";

const steps = [
  {
    icon: UploadIcon,
    label: "Upload shipping documents",
    description: "Upload images of your shipping documents and OCR will automatically extract the information",
    linkLabel: "Go to upload",
    linkUrl: "/upload"
  },
  {
    icon: OrderIcon,
    label: "Review in shipments list",
    description: "After OCR processing is complete, your shipments will automatically appear in the list",
    linkLabel: "View shipments",
    linkUrl: "/shipments"
  },
  {
    icon: EditIcon,
    label: "Review and edit details",
    description: "Click on any shipment card to view and edit detailed information",
    linkLabel: "Go to editor",
    linkUrl: "/edit"
  },
];

const StartGuide = ({ onDismiss }: { onDismiss: () => void }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <Card>
      <Box padding="400" background="bg-surface">
        <BlockStack gap="400">
          {/* Header */}
          <InlineStack align="space-between">
            <BlockStack gap="100">
              <Text as="h3" variant="headingLg">
                Get started with inventory management
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Set up your inventory management in <Text as="span" fontWeight="bold">3 steps</Text>
              </Text>
            </BlockStack>
            <Button
              onClick={onDismiss}
              variant="plain"
              size="slim"
              icon={XIcon}
              accessibilityLabel="Close guide"
            />
          </InlineStack>

          {/* Steps */}
          {isExpanded && (
            <BlockStack gap="300">
              {steps.map((step, idx) => (
                <InlineStack key={step.label} gap="300" align="start">
                  <Badge tone="info">{String(idx + 1)}</Badge>
                  <Icon source={step.icon} />
                  <BlockStack gap="100">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {step.label}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {step.description}
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button
                        variant="plain"
                        size="slim"
                        url={step.linkUrl}
                        external={false}
                      >
                        {step.linkLabel}
                      </Button>
                    </Box>
                  </BlockStack>
                </InlineStack>
              ))}
            </BlockStack>
          )}

          {/* Call to action */}
          <Box paddingBlockStart="400" paddingBlockEnd="200">
            <Button
              onClick={onDismiss}
              variant="primary"
              size="medium"
              fullWidth
            >
              Start by uploading your first document!
            </Button>
          </Box>
        </BlockStack>
      </Box>
    </Card>
  );
};

export default StartGuide;