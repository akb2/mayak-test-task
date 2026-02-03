import { SubscriptionStatus } from "src/models/subscription";
import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { UserEntity } from "./user";

@Entity()
export class SubscriptionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({
    type: "uuid",
  })
  userId: string;

  @OneToOne(() => UserEntity, {
    onDelete: "CASCADE"
  })
  @JoinColumn({ name: "userId" })
  user: UserEntity;

  @Column({
    type: "enum",
    enum: SubscriptionStatus,
    default: SubscriptionStatus.INACTIVE,
  })
  status: SubscriptionStatus;

  @Column({
    type: "timestamp",
    nullable: true,
    default: null,
  })
  currentPeriodStart: Date;

  @Column({
    type: "timestamp",
    nullable: true,
    default: null,
  })
  currentPeriodEnd: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}